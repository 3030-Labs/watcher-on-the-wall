/**
 * Regression test for HIGH-4: Unhandled rejection shutdown.
 *
 * Verifies that the Daemon class installs an "unhandledRejection" listener
 * on the process object when signal handlers are installed, and that the
 * listener triggers shutdown.
 *
 * Testing strategy: We cannot actually trigger process.exit in a test suite
 * (it would kill the Vitest runner). Instead we:
 *
 *   1. Create a minimal Daemon instance
 *   2. Call the private installSignalHandlers() method
 *   3. Verify that process.listeners("unhandledRejection") has a new entry
 *   4. Verify that invoking the listener calls shutdown(1) via spy
 *
 * We also clean up by removing the listeners we added so they don't affect
 * other tests or the test runner.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../../src/daemon/index.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-daemon-rej-"));
}

describe("HIGH-4: unhandled rejection triggers shutdown", () => {
  // Track listeners we add so we can clean them up.
  const addedListeners: Array<{ event: string; fn: (...args: unknown[]) => void }> = [];

  afterEach(() => {
    // Remove any listeners we added to prevent interference with other tests
    // or the test runner.
    for (const { event, fn } of addedListeners) {
      process.removeListener(event, fn);
    }
    addedListeners.length = 0;
  });

  it("installs an unhandledRejection listener when signal handlers are installed", () => {
    const root = tmp();
    const daemon = new Daemon({
      configPath: null,
      workingDir: root,
    });

    // Record the current set of listeners before installation.
    const listenersBefore = process.listeners("unhandledRejection").slice();

    // Call the private installSignalHandlers() via type cast.
    (daemon as unknown as { installSignalHandlers(): void }).installSignalHandlers();

    // Identify newly added listeners.
    const listenersAfter = process.listeners("unhandledRejection");
    const newListeners = listenersAfter.filter((fn) => !listenersBefore.includes(fn));

    expect(newListeners.length).toBeGreaterThanOrEqual(1);

    // Track for cleanup.
    for (const fn of newListeners) {
      addedListeners.push({ event: "unhandledRejection", fn: fn as (...args: unknown[]) => void });
    }

    // Also track SIGTERM, SIGINT, uncaughtException listeners added by daemon.
    for (const event of ["SIGTERM", "SIGINT", "uncaughtException"] as const) {
      // We only tracked unhandledRejection before/after; skip cleanup for these.
      void event;
    }
  });

  it("the unhandledRejection listener calls shutdown(1)", async () => {
    const root = tmp();
    const daemon = new Daemon({
      configPath: null,
      workingDir: root,
    });

    // Spy on shutdown — replace it with a no-op to prevent process.exit().
    const shutdownSpy = vi.fn().mockResolvedValue(undefined);
    (daemon as unknown as { shutdown: typeof shutdownSpy }).shutdown = shutdownSpy;

    // Record listeners before.
    const listenersBefore = process.listeners("unhandledRejection").slice();

    // Install signal handlers.
    (daemon as unknown as { installSignalHandlers(): void }).installSignalHandlers();

    // Find the newly installed listener.
    const listenersAfter = process.listeners("unhandledRejection");
    const newListeners = listenersAfter.filter((fn) => !listenersBefore.includes(fn));
    expect(newListeners.length).toBeGreaterThanOrEqual(1);

    // Track for cleanup (all newly added listeners across all events).
    for (const event of ["unhandledRejection", "SIGTERM", "SIGINT", "uncaughtException"]) {
      const currentListeners = process.listeners(event);
      for (const fn of currentListeners) {
        if (event === "unhandledRejection" && listenersBefore.includes(fn)) continue;
        // Be conservative: only track our unhandledRejection listener for sure
        if (event === "unhandledRejection") {
          addedListeners.push({ event, fn: fn as (...args: unknown[]) => void });
        }
      }
    }

    // Invoke the listener with a synthetic rejection reason.
    const handler = newListeners[0]! as (reason: unknown) => void;
    handler(new Error("test rejection"));

    // shutdown is called with void (fire-and-forget via `void this.shutdown(1)`),
    // so we give it a tick.
    await new Promise((r) => setTimeout(r, 10));

    expect(shutdownSpy).toHaveBeenCalledWith(1);
  });

  it("also installs handlers for SIGTERM, SIGINT, and uncaughtException", () => {
    const root = tmp();
    const daemon = new Daemon({
      configPath: null,
      workingDir: root,
    });

    const beforeCounts = {
      SIGTERM: process.listenerCount("SIGTERM"),
      SIGINT: process.listenerCount("SIGINT"),
      uncaughtException: process.listenerCount("uncaughtException"),
      unhandledRejection: process.listenerCount("unhandledRejection"),
    };

    (daemon as unknown as { installSignalHandlers(): void }).installSignalHandlers();

    // Each event should have at least one more listener than before.
    expect(process.listenerCount("SIGTERM")).toBeGreaterThan(beforeCounts.SIGTERM);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(beforeCounts.SIGINT);
    expect(process.listenerCount("uncaughtException")).toBeGreaterThan(
      beforeCounts.uncaughtException,
    );
    expect(process.listenerCount("unhandledRejection")).toBeGreaterThan(
      beforeCounts.unhandledRejection,
    );

    // Clean up all newly added listeners.
    for (const event of ["SIGTERM", "SIGINT", "uncaughtException", "unhandledRejection"] as const) {
      const current = process.listeners(event);
      // Remove listeners beyond the count we had before.
      const added = current.slice(beforeCounts[event]);
      for (const fn of added) {
        addedListeners.push({ event, fn: fn as (...args: unknown[]) => void });
      }
    }
  });
});
