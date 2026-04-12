/**
 * Unit tests for watcher/debounce.ts: DebounceBatcher.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebounceBatcher } from "../../src/watcher/debounce.js";
import type { DebounceOptions } from "../../src/watcher/debounce.js";

const fastOpts: DebounceOptions = {
  initialMs: 50,
  maxMs: 500,
  growthFactor: 2,
  burstThreshold: 10,
  maxBatchSize: 100,
};

afterEach(() => {
  vi.useRealTimers();
});

describe("DebounceBatcher", () => {
  it("batches multiple rapid adds into one flush", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const batcher = new DebounceBatcher(fastOpts, (paths) => {
      flushes.push([...paths]);
    });

    batcher.push("/a.ts");
    batcher.push("/b.ts");
    batcher.push("/c.ts");

    // Advance past the debounce window
    await vi.advanceTimersByTimeAsync(fastOpts.initialMs + 10);

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toContain("/a.ts");
    expect(flushes[0]).toContain("/b.ts");
    expect(flushes[0]).toContain("/c.ts");

    batcher.stop();
  });

  it("deduplicates repeated adds of the same path", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const batcher = new DebounceBatcher(fastOpts, (paths) => {
      flushes.push([...paths]);
    });

    batcher.push("/same.ts");
    batcher.push("/same.ts");
    batcher.push("/same.ts");

    await vi.advanceTimersByTimeAsync(fastOpts.initialMs + 10);

    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual(["/same.ts"]);

    batcher.stop();
  });

  it("flushes separately after delay resets", async () => {
    vi.useFakeTimers();
    const flushes: string[][] = [];
    const batcher = new DebounceBatcher(fastOpts, (paths) => {
      flushes.push([...paths]);
    });

    // First batch
    batcher.push("/first.ts");
    await vi.advanceTimersByTimeAsync(fastOpts.initialMs + 10);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]).toEqual(["/first.ts"]);

    // Second batch — after the first has flushed
    batcher.push("/second.ts");
    await vi.advanceTimersByTimeAsync(fastOpts.initialMs + 10);
    expect(flushes).toHaveLength(2);
    expect(flushes[1]).toEqual(["/second.ts"]);

    batcher.stop();
  });
});
