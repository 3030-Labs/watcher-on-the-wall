/**
 * Process manager for spawning the daemon as a true background process.
 * Parent calls {@link spawnDaemon}, which spawns a detached child using
 * `child_process.spawn(process.execPath, ...)`, unrefs it, and returns the
 * child's PID once it has written its PID file (or times out).
 *
 * We intentionally avoid {@link fork} because it opens an IPC channel that
 * keeps the parent alive even after {@link ChildProcess.unref}. Spawn with
 * `stdio: 'ignore'` has no such channel and lets the parent exit cleanly.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirExists } from "../utils/fs.js";
import { readPidFile } from "./lifecycle.js";

/**
 * Resolve the path to the daemon entrypoint built by tsup.
 */
export function resolveDaemonEntrypoint(): string {
  // When bundled by tsup, daemon code lives alongside the CLI entrypoint.
  // We use import.meta.url of *this* module and walk up to the dist root.
  const here = fileURLToPath(import.meta.url);
  const distRoot = resolve(here, "..", ".."); // dist/daemon -> dist
  const candidates = [
    resolve(distRoot, "daemon", "entry.js"),
    resolve(distRoot, "daemon-entry.js"),
    resolve(distRoot, "daemon", "index.js"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  // Fallback: assume it lives next to the CLI in a flat dist layout
  return resolve(distRoot, "daemon", "entry.js");
}

export interface SpawnDaemonOptions {
  configPath: string | null;
  pidFile: string;
  logFile: string;
  workingDir: string;
  entrypoint?: string;
  timeoutMs?: number;
}

/**
 * Spawn the daemon as a detached child process. Waits for the PID file to appear
 * before returning, so callers know the daemon has fully initialized.
 */
export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<{ pid: number }> {
  const entry = opts.entrypoint ?? resolveDaemonEntrypoint();
  if (!dirExists(opts.workingDir)) {
    throw new Error(`spawnDaemon: working directory does not exist: ${opts.workingDir}`);
  }
  if (!existsSync(entry)) {
    throw new Error(
      `spawnDaemon: daemon entrypoint not found at ${entry}. Did you run 'pnpm build'?`,
    );
  }

  const args = [entry, "--daemon-child"];
  if (opts.configPath) args.push("--config", opts.configPath);

  const child = spawn(process.execPath, args, {
    cwd: opts.workingDir,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      WOTW_DAEMON_CHILD: "1",
      WOTW_PID_FILE: opts.pidFile,
      WOTW_LOG_FILE: opts.logFile,
    },
  });

  // Detach so the child survives parent exit
  child.unref();

  // Wait for the child to write its PID file (or exit with an error)
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const pidContents = readPidFile(opts.pidFile);
    if (pidContents && pidContents.pid === child.pid) {
      return { pid: child.pid };
    }
    if (child.exitCode !== null) {
      throw new Error(
        `Daemon child exited prematurely with code ${child.exitCode}. ` +
          `Early-init errors (config validation, native-binding load, ` +
          `permission denied on wiki_root/raw_path) land in the daemon ` +
          `log file, not on stdout. Check it for the actual cause:\n` +
          `  cat ${opts.logFile}\n` +
          `If the log is empty or missing, the child crashed before ` +
          `logger initialization — re-run with \`wotw start --foreground\` ` +
          `to see the error directly on your terminal.`,
      );
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Timed out — tear down the child if still alive
  try {
    if (child.pid) process.kill(child.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  throw new Error(
    `Daemon did not initialize within ${timeoutMs}ms. ` +
      `If the daemon is still alive but slow to bind, check ${opts.logFile} ` +
      `for progress logs and increase startup timeout if needed.`,
  );
}

export interface RunForegroundOptions {
  configPath: string | null;
  pidFile: string;
  logFile: string;
  workingDir: string;
  entrypoint?: string;
}

/**
 * Run the daemon in the FOREGROUND by spawning the same fully-wired
 * `entry.js` the detached path uses — but attached to this terminal
 * (`stdio: "inherit"`, no detach). Resolves when the child exits with the
 * child's exit code.
 *
 * Why spawn rather than run in-process: `entry.js` wires every subsystem
 * (ingestion, watcher, MCP server, fact store) via a module-level
 * `void main()` side effect. Importing it into the CLI process would be
 * fragile; spawning the identical entrypoint reuses the validated path
 * verbatim. This closes PASS-023 dogfood finding #18 — previously the
 * foreground branch ran a bare `new Daemon()` with ZERO subsystems
 * registered, so `wotw start --foreground` looked like it started but
 * ingested nothing.
 *
 * SIGINT/SIGTERM are forwarded to the child so Ctrl-C stops the daemon
 * cleanly (the child's own signal handlers run its graceful shutdown).
 */
export async function runDaemonForeground(opts: RunForegroundOptions): Promise<number> {
  const entry = opts.entrypoint ?? resolveDaemonEntrypoint();
  if (!dirExists(opts.workingDir)) {
    throw new Error(`runDaemonForeground: working directory does not exist: ${opts.workingDir}`);
  }
  if (!existsSync(entry)) {
    throw new Error(
      `runDaemonForeground: daemon entrypoint not found at ${entry}. Did you run 'pnpm build'?`,
    );
  }

  const args = [entry, "--daemon-child"];
  if (opts.configPath) args.push("--config", opts.configPath);

  const child = spawn(process.execPath, args, {
    cwd: opts.workingDir,
    detached: false,
    stdio: "inherit",
    env: {
      ...process.env,
      WOTW_DAEMON_CHILD: "1",
      WOTW_PID_FILE: opts.pidFile,
      WOTW_LOG_FILE: opts.logFile,
      // Stream pretty logs to the inherited terminal so the foreground run
      // isn't silent (the daemon would otherwise write JSON to the log file).
      WOTW_LOG_STDOUT: "1",
    },
  });

  const forward = (signal: NodeJS.Signals): void => {
    if (child.pid && child.exitCode === null) {
      try {
        child.kill(signal);
      } catch {
        /* child already gone */
      }
    }
  };
  process.on("SIGINT", forward);
  process.on("SIGTERM", forward);

  return await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
      // Signal-terminated (e.g. Ctrl-C) is a clean foreground stop → 0.
      resolve(signal !== null ? 0 : (code ?? 0));
    });
  });
}
