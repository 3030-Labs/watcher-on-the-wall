/**
 * CLI invoker. Spawns the native `claude` binary for an ingestion or query
 * operation when the daemon is running in CLI mode.
 *
 * Why spawn a subprocess instead of using the Agent SDK here?
 *   - CLI mode is intended for users who already pay for Claude Pro/Max.
 *     The CLI uses their existing subscription at zero marginal cost.
 *   - The SDK, by contrast, requires an API key and bills per token.
 *
 * The CLI's streaming tool-use traffic isn't exposed to us via a clean
 * protocol, so we determine which files the agent wrote by snapshotting the
 * wiki directory tree (path → mtime + size) before and after the run and
 * diffing the results. This is robust to any future changes in CLI output
 * format, works across stdio/stream-json/text modes, and doesn't require
 * parsing the CLI's messages at all.
 *
 * Arguments passed to `claude`:
 *
 *   claude --print --dangerously-skip-permissions
 *          --model <cli_model>
 *          --append-system-prompt <systemPrompt>
 *          [--max-turns <n>]
 *
 * The user prompt is piped on stdin rather than an argv entry so we don't
 * hit ARG_MAX limits on large batch prompts.
 */
import { spawn } from "node:child_process";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { getLogger } from "../utils/logger.js";
import type { InvokeOptions, InvokeResult } from "./llm-invoker.js";

export interface CliInvokerConfig {
  /** Path to the `claude` binary (absolute or bare name on PATH). */
  cliPath: string;
  /** Model ID to pass via `--model`. */
  cliModel: string;
  /** Kill the subprocess if it runs longer than this (ms). Default 10 min. */
  timeoutMs?: number;
}

/**
 * Invoke the Claude CLI for an ingestion/query/compound operation.
 *
 * @param config CLI-specific configuration (binary path, model, timeout)
 * @param opts operation-specific options (cwd, prompts, maxTurns, ...)
 * @returns an {@link InvokeResult} with cost=0 and wiki-diff-derived `writtenPaths`
 */
export async function invokeClaudeCli(
  config: CliInvokerConfig,
  opts: InvokeOptions,
): Promise<InvokeResult> {
  const log = getLogger("cli-invoker");
  const timeoutMs = config.timeoutMs ?? 10 * 60 * 1000;

  // Snapshot the wiki directory before the run so we can compute which
  // files changed. We only care about files under cwd — raw/ is outside
  // and we never expect the agent to touch it.
  const before = snapshotTree(opts.cwd);

  const args = ["--print", "--dangerously-skip-permissions", "--model", config.cliModel];
  // `--append-system-prompt` is what the CLI uses to layer extra instructions
  // on top of the bundled system prompt. Equivalent to the SDK's
  // `systemPrompt.append` field.
  if (opts.systemPrompt && opts.systemPrompt.trim().length > 0) {
    args.push("--append-system-prompt", opts.systemPrompt);
  }
  if (Number.isFinite(opts.maxTurns) && opts.maxTurns > 0) {
    // The CLI's --max-turns flag is accepted by recent versions. If an older
    // CLI is on PATH and rejects the flag, we'll surface the stderr message
    // to the caller — the ingestion queue then skips the batch cleanly.
    args.push("--max-turns", String(opts.maxTurns));
  }

  log.info(
    {
      cliPath: config.cliPath,
      model: config.cliModel,
      cwd: opts.cwd,
      maxTurns: opts.maxTurns,
      userPromptChars: opts.userPrompt.length,
    },
    "spawning claude CLI",
  );

  const started = Date.now();
  const child = spawn(config.cliPath, args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    // Full-env propagation (L-SEC-2). We deliberately forward the entire
    // parent environment so the `claude` binary can find `git`, locate
    // user dot-config (`~/.claude/*`), read the subscription session
    // cookie, etc. This also means `ANTHROPIC_API_KEY` will be inherited
    // if the operator has one set in their shell — the CLI will happily
    // fall back to API billing in that case, which is the documented
    // behavior of `claude --print`. Operators who want strict
    // subscription-only behavior must unset `ANTHROPIC_API_KEY` in the
    // shell that starts the daemon. This trade-off is covered in
    // docs/execution-modes.md.
    env: { ...process.env },
  });

  // Honor an external abort controller so the daemon can cancel on shutdown.
  const abortHandler = (): void => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* process may already be dead */
    }
  };
  opts.abortController?.signal.addEventListener("abort", abortHandler);

  // Timeout safety net — unref so an orphaned timer doesn't keep the event
  // loop alive in test suites.
  const timer = setTimeout(() => {
    log.warn({ timeoutMs }, "claude CLI exceeded timeout, sending SIGTERM");
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
  }, timeoutMs);
  timer.unref();

  // Stream the user prompt via stdin. Guard against EPIPE if the CLI exits
  // before accepting all the bytes.
  try {
    child.stdin.write(opts.userPrompt);
    child.stdin.end();
  } catch (err) {
    log.warn({ err }, "failed to write prompt to claude stdin");
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exit: { code: number | null; signal: NodeJS.Signals | null } = await new Promise(
    (resolve) => {
      child.on("error", (err) => {
        log.error({ err }, "claude CLI spawn error");
        resolve({ code: -1, signal: null });
      });
      child.on("close", (code, signal) => {
        resolve({ code, signal });
      });
    },
  );
  clearTimeout(timer);
  opts.abortController?.signal.removeEventListener("abort", abortHandler);

  const durationMs = Date.now() - started;
  const success = exit.code === 0;

  if (!success) {
    log.warn(
      {
        exitCode: exit.code,
        signal: exit.signal,
        stderrTail: stderr.slice(-512),
      },
      "claude CLI exited non-zero",
    );
  }

  // Diff the wiki tree to find which files were written/modified.
  const after = snapshotTree(opts.cwd);
  const writtenPaths = diffSnapshots(before, after);

  return {
    finalText: stdout,
    // CLI mode is covered by the user's subscription — no per-op cost.
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs,
    numTurns: 0,
    sessionId: null,
    writtenPaths: writtenPaths.sort(),
    stopReason: success ? "end_turn" : (exit.signal ?? `exit_${exit.code}`),
    success,
  };
}

/** Snapshot entry: size + mtime-ms for cheap diffing. */
interface FileStat {
  size: number;
  mtimeMs: number;
}

/**
 * Walk `root` recursively and return a map of absolute path → stat summary.
 * Skips directories that are known to be noisy or irrelevant to wiki state:
 * `.git`, `node_modules`, hidden files at the wiki root. Errors from
 * individual stat calls are swallowed so a transient ENOENT doesn't derail
 * the whole snapshot.
 */
function snapshotTree(root: string): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      // Skip the immutable raw/ directory — the agent never writes there.
      if (dir === root && entry.name === "raw") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        try {
          const st = statSync(abs);
          out.set(abs, { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* skip unreadable entry */
        }
      }
    }
  }
  return out;
}

/**
 * Diff two snapshots and return the list of paths that were either created
 * or modified between them. A path is considered modified if its size OR
 * mtime changed. This catches the normal case (agent writes → mtime bumps)
 * and the pathological case of an idempotent re-write of identical content.
 */
function diffSnapshots(before: Map<string, FileStat>, after: Map<string, FileStat>): string[] {
  const changed: string[] = [];
  for (const [path, a] of after) {
    const b = before.get(path);
    if (!b) {
      changed.push(path);
      continue;
    }
    if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
      changed.push(path);
    }
  }
  return changed;
}
