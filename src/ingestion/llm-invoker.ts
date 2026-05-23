/**
 * Wraps both runtimes so the ingestion queue can call a single structured
 * function and get back an identical result shape regardless of whether we
 * spawned the `claude` CLI binary or the Agent SDK. The invoker owns:
 *
 *   - Runtime dispatch (CLI vs API) based on the resolved execution mode
 *   - System prompt composition (via prompt-builder)
 *   - Session cwd pinning (always the wiki_root)
 *   - Tool restriction (Read, Write, Edit, Glob, Grep only) — API mode
 *   - Abort controller for shutdown safety
 *   - Retry on transient SDK errors
 *
 * CLI mode does NOT use the Agent SDK at all. See {@link ./cli-invoker.ts}.
 * API mode uses the SDK's `query()` async generator and tracks
 * per-operation cost via `total_cost_usd`.
 */
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { getLogger } from "../utils/logger.js";
import { retry, type RetryOptions } from "../utils/retry.js";
import type { ModelId, RuntimeMode } from "../utils/types.js";
import { invokeClaudeCli, type CliInvokerConfig } from "./cli-invoker.js";

export interface InvokeOptions {
  /** Absolute path to pin the agent's working directory. */
  cwd: string;
  /** Additional readable/writable directories beyond cwd. */
  additionalDirectories?: string[];
  /** System prompt (our CLAUDE.md). */
  systemPrompt: string;
  /** First user turn text. */
  userPrompt: string;
  /** Model ID to use. */
  model: ModelId;
  /** Hard cap on agentic turns before the loop is forcibly ended. */
  maxTurns: number;
  /** Optional abort controller so callers can cancel mid-flight. */
  abortController?: AbortController;
  /** Retry policy for transient failures. */
  retry?: RetryOptions;
  /** Resume an existing session ID for multi-batch conversations. */
  resumeSessionId?: string;
  /**
   * Which runtime to invoke. Defaults to `api` to preserve the historical
   * behavior of unit tests and callers that haven't been updated yet.
   */
  runtimeMode?: RuntimeMode;
  /**
   * CLI-specific configuration (path, model). Required when
   * `runtimeMode === "cli"`.
   */
  cliConfig?: CliInvokerConfig;
  /**
   * Tool whitelist for the agent. Defaults to {@link INGESTION_TOOLS}
   * (Read/Write/Edit/Glob/Grep/TodoWrite). Pass a narrower list for
   * read-only callers (e.g. the query engine uses `Read/Glob/Grep` only).
   * Only applied in API mode — the CLI relies on
   * `--dangerously-skip-permissions` to grant tool access.
   */
  allowedTools?: string[];
}

export interface InvokeResult {
  /** Terminal assistant text (may be empty). */
  finalText: string;
  /** Aggregated cost in USD as reported by the SDK. */
  totalCostUsd: number;
  /** Total input tokens across all turns. */
  inputTokens: number;
  /** Total output tokens across all turns. */
  outputTokens: number;
  /** Wall-clock duration (ms). */
  durationMs: number;
  /** Number of agentic turns taken. */
  numTurns: number;
  /** Session ID (for resume). */
  sessionId: string | null;
  /** All absolute paths the agent appeared to Write or Edit. */
  writtenPaths: string[];
  /** Stop reason reported by the SDK. */
  stopReason: string | null;
  /** True if the result subtype was 'success'. */
  success: boolean;
}

const INGESTION_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "TodoWrite"];

/**
 * Run the agent loop for a single ingestion batch. Dispatches to the CLI
 * invoker when `runtimeMode === "cli"`; otherwise uses the Agent SDK.
 */
export async function invokeIngestionAgent(opts: InvokeOptions): Promise<InvokeResult> {
  const log = getLogger("llm-invoker");

  if (opts.runtimeMode === "cli") {
    if (!opts.cliConfig) {
      throw new Error("invokeIngestionAgent: runtimeMode=cli requires cliConfig");
    }
    // CLI mode bypasses retry-with-backoff — the subprocess contract is
    // simpler (spawn returns a single exit code) and the caller's
    // ingestion queue already has a skip-on-failure branch. Wrapping the
    // CLI call in our generic retry helper would mostly just mask real
    // configuration errors (wrong binary, missing model) behind delays.
    return invokeClaudeCli(opts.cliConfig, opts);
  }

  const retryOpts: Partial<RetryOptions> = opts.retry ?? {
    retries: 2,
    initialDelayMs: 2_000,
    maxDelayMs: 30_000,
    factor: 2,
    onRetry: (err, attempt, delay) => {
      log.warn({ err, attempt, delay }, "retrying ingestion agent invocation");
    },
  };

  let attemptNum = 0;
  return retry(async () => {
    attemptNum += 1;
    const abort = opts.abortController ?? new AbortController();
    log.info(
      {
        attempt: attemptNum,
        model: opts.model,
        cwd: opts.cwd,
        maxTurns: opts.maxTurns,
        resumeSessionId: opts.resumeSessionId ?? null,
      },
      "invoking ingestion agent",
    );

    const tools = opts.allowedTools ?? INGESTION_TOOLS;
    const queryOptions: Options = {
      cwd: opts.cwd,
      additionalDirectories: opts.additionalDirectories,
      systemPrompt: { type: "preset", preset: "claude_code", append: opts.systemPrompt },
      model: opts.model,
      maxTurns: opts.maxTurns,
      allowedTools: tools,
      tools,
      // Review item 26: when allowedTools is empty (single-pass mode
      // post-Phase 6), "bypassPermissions" is a meaningless attack-
      // surface widener — there are no tools to grant. Default to
      // the SDK's "default" mode for the empty-tools path; keep the
      // bypass for the legacy multi-turn / tools-allowed shape.
      permissionMode: tools.length === 0 ? "default" : "bypassPermissions",
      abortController: abort,
      // Point SDK at the user-installed @anthropic-ai/claude-code launcher.
      // SDK default resolution looks for a platform-specific sibling package
      // binary (not installed in our container — we use claude-code's
      // install.cjs to fetch the native binary), then falls back to ./cli.js
      // adjacent to the SDK module (also not present in 2.1.x layout).
      // Without this override the SDK throws "Native CLI binary for
      // ${process.platform}-${process.arch} not found" at spawn time.
      pathToClaudeCodeExecutable:
        process.env.WOTW_CLAUDE_CLI_PATH ?? "/app/node_modules/.bin/claude",
      ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
    };

    const started = Date.now();
    const q = query({ prompt: opts.userPrompt, options: queryOptions });

    let finalText = "";
    let totalCostUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let numTurns = 0;
    let sessionId: string | null = null;
    let stopReason: string | null = null;
    let success = false;
    const writtenPaths = new Set<string>();

    try {
      for await (const msg of q as AsyncIterable<SDKMessage>) {
        if (msg.type === "system") {
          if ("session_id" in msg && typeof msg.session_id === "string") {
            sessionId = msg.session_id;
          }
        } else if (msg.type === "assistant") {
          // Track tool_use blocks for Write/Edit — we'll scrape file paths.
          const content = (msg as { message?: { content?: unknown[] } }).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              const b = block as {
                type?: string;
                name?: string;
                input?: Record<string, unknown>;
              };
              if (b.type === "tool_use" && (b.name === "Write" || b.name === "Edit")) {
                const p = b.input?.file_path;
                if (typeof p === "string") writtenPaths.add(p);
              }
            }
          }
        } else if (msg.type === "result") {
          const r = msg as {
            subtype?: string;
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
            result?: string;
            num_turns?: number;
            stop_reason?: string | null;
            session_id?: string;
          };
          success = r.subtype === "success";
          totalCostUsd = r.total_cost_usd ?? 0;
          inputTokens = r.usage?.input_tokens ?? 0;
          outputTokens = r.usage?.output_tokens ?? 0;
          finalText = r.result ?? "";
          numTurns = r.num_turns ?? 0;
          stopReason = r.stop_reason ?? null;
          if (!sessionId && r.session_id) sessionId = r.session_id;
        }
      }
    } catch (err) {
      log.error({ err, attempt: attemptNum }, "agent SDK stream failed");
      throw err;
    }

    const durationMs = Date.now() - started;

    if (!success) {
      log.warn({ stopReason, numTurns, durationMs }, "ingestion agent did not return success");
    }

    return {
      finalText,
      totalCostUsd,
      inputTokens,
      outputTokens,
      durationMs,
      numTurns,
      sessionId,
      writtenPaths: [...writtenPaths].sort(),
      stopReason,
      success,
    };
  }, retryOpts);
}
