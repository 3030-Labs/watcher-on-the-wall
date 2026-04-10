/**
 * Daemon lifecycle: PID file management, file locking, graceful shutdown.
 *
 * A running daemon has three facts associated with it:
 *   1. A PID file containing its numeric PID and a timestamp.
 *   2. A lock file that prevents two daemons from starting simultaneously.
 *   3. A log file where pino writes structured events.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { ensureDirSync, removeIfExistsSync } from "../utils/fs.js";

export interface PidFileContents {
  pid: number;
  started_at: string;
  version: string;
}

/**
 * Write the PID file atomically.
 */
export function writePidFile(pidFilePath: string, contents: PidFileContents): void {
  ensureDirSync(dirname(pidFilePath));
  writeFileSync(pidFilePath, JSON.stringify(contents));
}

/**
 * Read a PID file, returning null if missing or malformed.
 */
export function readPidFile(pidFilePath: string): PidFileContents | null {
  if (!existsSync(pidFilePath)) return null;
  try {
    const raw = readFileSync(pidFilePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "pid" in parsed &&
      typeof (parsed as { pid: unknown }).pid === "number"
    ) {
      return parsed as PidFileContents;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Remove the PID file, ignoring missing files.
 */
export function removePidFile(pidFilePath: string): void {
  removeIfExistsSync(pidFilePath);
}

/**
 * Check whether a process is alive by sending signal 0. Returns true if it is
 * still alive, false otherwise. Handles EPERM (process owned by another user)
 * by returning true, since the process exists even if we cannot signal it.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return false;
  }
}

/**
 * Check liveness based on the PID file: returns {alive, pid, contents}.
 * If the PID file references a dead process, the file is considered stale.
 */
export function checkDaemonAlive(pidFilePath: string): {
  alive: boolean;
  pid: number | null;
  stale: boolean;
  contents: PidFileContents | null;
} {
  const contents = readPidFile(pidFilePath);
  if (!contents) return { alive: false, pid: null, stale: false, contents: null };
  const alive = isProcessAlive(contents.pid);
  return { alive, pid: contents.pid, stale: !alive, contents };
}

/**
 * Acquire the daemon start-lock. Returns a release function on success.
 * Throws if another process holds the lock.
 */
export async function acquireStartLock(lockPath: string): Promise<() => Promise<void>> {
  ensureDirSync(dirname(lockPath));
  // proper-lockfile requires the target file to exist; create a zero-byte stub if missing.
  if (!existsSync(lockPath)) writeFileSync(lockPath, "");
  const release = await lockfile.lock(lockPath, {
    stale: 10_000,
    retries: { retries: 0 },
  });
  return release;
}

/**
 * Send SIGTERM to a PID and wait up to `timeoutMs` for it to exit. Returns true
 * if the process exited, false if it is still alive after the timeout.
 */
export async function terminateAndWait(pid: number, timeoutMs = 10_000): Promise<boolean> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return true;
    throw err;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !isProcessAlive(pid);
}
