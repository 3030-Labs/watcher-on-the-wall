/**
 * Regression tests for CRITICAL-7 (batch retry + DLQ) and HIGH-3 (degraded flag).
 *
 * Tests exercise the FileWatcher retry logic (retryCount Map, max 3 retries,
 * onDropped callback) and the isDegraded() flag set on chokidar errors.
 *
 * Strategy: We bypass chokidar by NOT calling start(). Instead we directly
 * invoke the DebounceBatcher's flush cycle via flushNow(), which calls the
 * private emitBatch() callback. This isolates the retry/DLQ logic from
 * filesystem watching.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileWatcher, type WatcherOptions } from "../../src/watcher/index.js";
import { defaultConfig } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-watcher-retry-"));
}

/**
 * Build a minimal WotwConfig with a real raw_path directory.
 * Uses very short debounce timings for test speed.
 */
function testConfig(rawPath: string): WotwConfig {
  const cfg = defaultConfig();
  cfg.raw_path = rawPath;
  cfg.watcher.debounce_initial_ms = 10;
  cfg.watcher.debounce_max_ms = 50;
  cfg.watcher.burst_threshold = 100;
  cfg.watcher.max_batch_size = 100;
  return cfg;
}

/**
 * Helper to access the internal batcher. The FileWatcher stores it as a
 * private field, so we use bracket notation to reach it for test purposes.
 */
function getBatcher(watcher: FileWatcher) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (watcher as any).batcher as import("../../src/watcher/debounce.js").DebounceBatcher;
}

/**
 * Helper to access the internal chokidar watcher field for synthetic events.
 */
function getInternalWatcher(watcher: FileWatcher) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (watcher as any).watcher as import("chokidar").FSWatcher | null;
}

describe("FileWatcher retry logic (CRITICAL-7)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries file on transient batch failure", async () => {
    const dir = tmpDir();
    const rawPath = join(dir, "raw");
    mkdirSync(rawPath, { recursive: true });

    let callCount = 0;
    const processedBatches: string[][] = [];

    const opts: WatcherOptions = {
      config: testConfig(rawPath),
      onBatch: async (batch) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("transient failure");
        }
        // Second call succeeds
        processedBatches.push([...batch.paths]);
      },
    };

    const watcher = new FileWatcher(opts);
    const batcher = getBatcher(watcher);

    // Manually push a file path into the batcher (simulating a detected file)
    batcher.push("/fake/raw/test-file.md");

    // Flush to trigger onBatch (which will throw on first call)
    await batcher.flushNow();

    // The error in emitBatch re-queues the path into the batcher.
    // The retryCount for this path should now be 1.
    // Advance timers so the batcher's re-armed timer fires.
    await vi.advanceTimersByTimeAsync(100);

    // The second flush should succeed
    expect(callCount).toBe(2);
    expect(processedBatches).toHaveLength(1);
    expect(processedBatches[0]).toContain("/fake/raw/test-file.md");

    batcher.stop();
  });

  it("sends to DLQ after max retries exceeded", async () => {
    const dir = tmpDir();
    const rawPath = join(dir, "raw");
    mkdirSync(rawPath, { recursive: true });

    const droppedFiles: Array<{ path: string; reason: string }> = [];
    let batchCallCount = 0;

    const opts: WatcherOptions = {
      config: testConfig(rawPath),
      onBatch: async () => {
        batchCallCount++;
        throw new Error("persistent failure");
      },
      onDropped: (path, reason) => {
        droppedFiles.push({ path, reason });
      },
    };

    const watcher = new FileWatcher(opts);
    const batcher = getBatcher(watcher);

    // Push a file and flush manually for each retry attempt.
    // Using flushNow() avoids timer-cascade issues with fake timers.

    // Attempt 1: retryCount goes from 0 -> 1, file re-queued
    batcher.push("/fake/raw/doomed-file.md");
    await batcher.flushNow();
    expect(batchCallCount).toBe(1);
    expect(droppedFiles).toHaveLength(0);
    expect(batcher.size()).toBe(1); // re-queued

    // Attempt 2: retryCount goes from 1 -> 2, file re-queued
    await batcher.flushNow();
    expect(batchCallCount).toBe(2);
    expect(droppedFiles).toHaveLength(0);
    expect(batcher.size()).toBe(1); // re-queued

    // Attempt 3: retryCount goes from 2 -> 3, file re-queued
    await batcher.flushNow();
    expect(batchCallCount).toBe(3);
    expect(droppedFiles).toHaveLength(0);
    expect(batcher.size()).toBe(1); // re-queued

    // Attempt 4: retryCount goes from 3 -> 4 (>3), file sent to DLQ
    await batcher.flushNow();
    expect(batchCallCount).toBe(4);
    expect(droppedFiles).toHaveLength(1);
    expect(droppedFiles[0]!.path).toBe("/fake/raw/doomed-file.md");
    expect(droppedFiles[0]!.reason).toBe("persistent failure");

    // Batcher should be empty now — no more re-queues
    expect(batcher.size()).toBe(0);

    batcher.stop();
  });

  it("tracks retries per-file independently", async () => {
    const dir = tmpDir();
    const rawPath = join(dir, "raw");
    mkdirSync(rawPath, { recursive: true });

    const droppedFiles: string[] = [];

    const opts: WatcherOptions = {
      config: testConfig(rawPath),
      onBatch: async () => {
        throw new Error("always fails");
      },
      onDropped: (path) => {
        droppedFiles.push(path);
      },
    };

    const watcher = new FileWatcher(opts);
    const batcher = getBatcher(watcher);

    // Push two files
    batcher.push("/fake/raw/file-a.md");
    batcher.push("/fake/raw/file-b.md");

    // Each flush attempt processes both files in the same batch.
    // After 4 total attempts, both should be dropped.
    for (let i = 0; i < 4; i++) {
      if (i === 0) {
        await batcher.flushNow();
      } else {
        await vi.advanceTimersByTimeAsync(100);
      }
    }

    expect(droppedFiles).toHaveLength(2);
    expect(droppedFiles).toContain("/fake/raw/file-a.md");
    expect(droppedFiles).toContain("/fake/raw/file-b.md");

    batcher.stop();
  });
});

describe("FileWatcher degraded flag (HIGH-3)", () => {
  it("isDegraded() returns false initially", () => {
    const dir = tmpDir();
    const rawPath = join(dir, "raw");
    mkdirSync(rawPath, { recursive: true });

    const opts: WatcherOptions = {
      config: testConfig(rawPath),
      onBatch: async () => {},
    };

    const watcher = new FileWatcher(opts);
    expect(watcher.isDegraded()).toBe(false);
  });

  it("isDegraded() returns true after chokidar error event", async () => {
    const dir = tmpDir();
    const rawPath = join(dir, "raw");
    mkdirSync(rawPath, { recursive: true });

    const opts: WatcherOptions = {
      config: testConfig(rawPath),
      onBatch: async () => {},
    };

    const watcher = new FileWatcher(opts);

    // Start the watcher to create the chokidar instance
    await watcher.start();

    // Verify initial state
    expect(watcher.isDegraded()).toBe(false);

    // Access the internal chokidar watcher and emit a synthetic error
    const internal = getInternalWatcher(watcher);
    expect(internal).not.toBeNull();
    internal!.emit("error", new Error("synthetic ENOSPC error"));

    // The error handler should set degraded = true
    expect(watcher.isDegraded()).toBe(true);

    // Clean up
    await watcher.stop();
  });
});
