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
      throw new Error(`Daemon child exited prematurely with code ${child.exitCode}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  // Timed out — tear down the child if still alive
  try {
    if (child.pid) process.kill(child.pid, "SIGTERM");
  } catch {
    /* ignore */
  }
  throw new Error(`Daemon did not initialize within ${timeoutMs}ms`);
}
