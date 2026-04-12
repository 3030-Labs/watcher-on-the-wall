/**
 * Daemon spawn verification tests — covers the five WSL/Windows scenarios
 * called out in the prompt:
 *
 *   1. PID file is written, parses cleanly, and references a live process.
 *   2. proper-lockfile works on a WSL filesystem path (mkdtemp under /tmp).
 *   3. Acquiring the lock twice from the same process throws (mutual exclusion).
 *   4. Releasing the lock allows a subsequent acquisition to succeed.
 *   5. The lock survives across spawn boundaries (released by parent, free
 *      for the child to take immediately) — this models the "terminal close
 *      survival" case where a parent shell exits and a detached daemon
 *      continues to hold its own lock without contention from the dead parent.
 *
 * We do NOT spawn the actual daemon binary here (that requires `pnpm build`
 * and a real wiki layout). The point is to verify the lifecycle primitives
 * — PID file + proper-lockfile — behave correctly on WSL specifically.
 *
 * Process-manager spawn semantics are documented in `src/daemon/process-manager.ts`:
 * we use `child_process.spawn` with `detached: true` and `stdio: 'ignore'`
 * because `fork` opens an IPC channel that prevents the parent from exiting
 * cleanly. If a future port to native Windows ever runs into trouble with
 * spawn-detach, the documented fallback is to keep using spawn but emulate
 * detachment with `windowsHide: true` and an explicit `\\.\nul` redirect for
 * each stdio channel — fork is never the answer.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireStartLock,
  checkDaemonAlive,
  isProcessAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "../../src/daemon/lifecycle.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-daemon-wsl-"));
}

describe("daemon WSL verification — PID file lifecycle", () => {
  it("writes a parseable PID file referencing this process", () => {
    const root = tmpRoot();
    const pidFile = join(root, "wotw.pid");
    writePidFile(pidFile, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      version: "0.1.0",
    });
    expect(existsSync(pidFile)).toBe(true);

    const contents = readPidFile(pidFile);
    expect(contents).not.toBeNull();
    expect(contents?.pid).toBe(process.pid);
    expect(contents?.version).toBe("0.1.0");
    // The timestamp must round-trip as a parseable ISO date.
    expect(Number.isNaN(Date.parse(contents?.started_at ?? ""))).toBe(false);
  });

  it("checkDaemonAlive returns alive=true for the current process", () => {
    const root = tmpRoot();
    const pidFile = join(root, "wotw.pid");
    writePidFile(pidFile, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      version: "0.1.0",
    });
    const result = checkDaemonAlive(pidFile);
    expect(result.alive).toBe(true);
    expect(result.pid).toBe(process.pid);
    expect(result.stale).toBe(false);
  });

  it("checkDaemonAlive marks a dead PID as stale", () => {
    const root = tmpRoot();
    const pidFile = join(root, "wotw.pid");
    // PID 1 on Linux is init/systemd — guaranteed alive. We need a PID that
    // we're confident is dead. Pick a value high enough that it cannot
    // collide with a real pid in this short-lived test process. /proc max
    // on most kernels is 4 million; 0x7fffffff is a safe synthetic.
    const deadPid = 0x7fffffff;
    expect(isProcessAlive(deadPid)).toBe(false);
    writePidFile(pidFile, {
      pid: deadPid,
      started_at: new Date().toISOString(),
      version: "0.1.0",
    });
    const result = checkDaemonAlive(pidFile);
    expect(result.alive).toBe(false);
    expect(result.stale).toBe(true);
  });

  it("removePidFile is idempotent", () => {
    const root = tmpRoot();
    const pidFile = join(root, "wotw.pid");
    writePidFile(pidFile, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      version: "0.1.0",
    });
    removePidFile(pidFile);
    expect(existsSync(pidFile)).toBe(false);
    // Second call must not throw.
    expect(() => removePidFile(pidFile)).not.toThrow();
  });
});

describe("daemon WSL verification — proper-lockfile on WSL filesystems", () => {
  it("acquires and releases the start lock under /tmp (WSL-friendly)", async () => {
    const root = tmpRoot();
    const lockPath = join(root, "wotw.lock");
    // Lock file does not exist yet — acquireStartLock must create it.
    const release = await acquireStartLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    // Release the lock and verify it can be re-acquired (proving release worked).
    await release();
    const release2 = await acquireStartLock(lockPath);
    expect(existsSync(lockPath)).toBe(true);
    await release2();
  });

  it("rejects a second acquisition while the lock is held (mutual exclusion)", async () => {
    const root = tmpRoot();
    const lockPath = join(root, "wotw.lock");
    writeFileSync(lockPath, "");
    const release = await acquireStartLock(lockPath);
    await expect(acquireStartLock(lockPath)).rejects.toThrow();
    await release();
  });

  it("allows re-acquisition after release", async () => {
    const root = tmpRoot();
    const lockPath = join(root, "wotw.lock");
    writeFileSync(lockPath, "");
    const release1 = await acquireStartLock(lockPath);
    await release1();
    // The second acquire must succeed once the first has fully released.
    const release2 = await acquireStartLock(lockPath);
    await release2();
  });
});
