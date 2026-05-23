/**
 * Unit tests for src/server/progressive-cache.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { ProgressiveCache } from "../../../src/server/progressive-cache.js";

function fakeEntry(
  overrides: Record<string, unknown> = {},
): Parameters<ProgressiveCache["put"]>[0] {
  return {
    question: "what is X?",
    hits: [],
    lastTierServed: 0,
    tokensShippedSoFar: 100,
    maxTokensTotal: 8192,
    ...overrides,
  } as Parameters<ProgressiveCache["put"]>[0];
}

describe("ProgressiveCache", () => {
  it("put/get round-trip preserves data", () => {
    const cache = new ProgressiveCache();
    const token = cache.put(fakeEntry());
    expect(token).toMatch(/^[0-9a-f-]{36}$/);
    const entry = cache.get(token);
    expect(entry?.question).toBe("what is X?");
    expect(entry?.tokensShippedSoFar).toBe(100);
  });
  it("missing tokens return null", () => {
    const cache = new ProgressiveCache();
    expect(cache.get("does-not-exist")).toBeNull();
  });
  it("update mutator applies and timestamp ticks", () => {
    const cache = new ProgressiveCache();
    const token = cache.put(fakeEntry());
    const ok = cache.update(token, (e) => {
      e.lastTierServed = 2;
      e.tokensShippedSoFar = 500;
    });
    expect(ok).toBe(true);
    const entry = cache.get(token);
    expect(entry?.lastTierServed).toBe(2);
    expect(entry?.tokensShippedSoFar).toBe(500);
  });
  it("delete drops the entry", () => {
    const cache = new ProgressiveCache();
    const token = cache.put(fakeEntry());
    cache.delete(token);
    expect(cache.get(token)).toBeNull();
  });
  it("LRU eviction at maxEntries cap drops the oldest entry", () => {
    const cache = new ProgressiveCache({ maxEntries: 3 });
    const a = cache.put(fakeEntry({ question: "a" }));
    const b = cache.put(fakeEntry({ question: "b" }));
    const c = cache.put(fakeEntry({ question: "c" }));
    // Touch b + c so a is the LRU.
    cache.get(b);
    cache.get(c);
    cache.put(fakeEntry({ question: "d" }));
    expect(cache.get(a)).toBeNull();
    expect(cache.get(b)?.question).toBe("b");
    expect(cache.get(c)?.question).toBe("c");
  });
  it("TTL expiry returns null", async () => {
    vi.useFakeTimers();
    const cache = new ProgressiveCache({ ttlMs: 1000 });
    const token = cache.put(fakeEntry());
    expect(cache.get(token)).not.toBeNull();
    vi.advanceTimersByTime(2000);
    expect(cache.get(token)).toBeNull();
    vi.useRealTimers();
  });
});
