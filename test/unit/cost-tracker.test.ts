/**
 * Unit tests for CostTracker: append, daily totals, budget checks.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";

function tmpTrackFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "wotw-cost-"));
  return join(dir, "cost-log.jsonl");
}

function makeTracker(
  overrides: Partial<{
    trackFile: string;
    maxDailyUsd: number;
    maxPerIngestUsd: number;
    maxPerQueryUsd: number;
  }> = {},
): CostTracker {
  return new CostTracker({
    trackFile: overrides.trackFile ?? tmpTrackFile(),
    maxDailyUsd: overrides.maxDailyUsd ?? 10.0,
    maxPerIngestUsd: overrides.maxPerIngestUsd ?? 2.0,
    maxPerQueryUsd: overrides.maxPerQueryUsd ?? 0.5,
  });
}

describe("CostTracker.record", () => {
  it("appends an entry as a single JSONL line", () => {
    const file = tmpTrackFile();
    const t = makeTracker({ trackFile: file });
    t.record({
      timestamp: "2026-04-07T00:00:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.01,
    });
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text.trim());
    expect(parsed.operation).toBe("ingest");
    expect(parsed.cost_usd).toBe(0.01);
  });

  it("appends multiple entries as distinct lines", () => {
    const file = tmpTrackFile();
    const t = makeTracker({ trackFile: file });
    for (let i = 0; i < 3; i++) {
      t.record({
        timestamp: "2026-04-07T00:00:00.000Z",
        operation: "query",
        model_id: "claude-sonnet-4-5",
        cost_usd: 0.1,
      });
    }
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
  });
});

describe("CostTracker.spentToday", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("returns 0 when the log does not exist", () => {
    const t = makeTracker();
    expect(t.spentToday()).toBe(0);
  });

  it("sums only today's entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
    const t = makeTracker();
    t.record({
      timestamp: "2026-04-06T23:59:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 1.0, // yesterday — excluded
    });
    t.record({
      timestamp: "2026-04-07T01:00:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.5,
    });
    t.record({
      timestamp: "2026-04-07T02:00:00.000Z",
      operation: "query",
      model_id: "claude-sonnet-4-5",
      cost_usd: 0.25,
    });
    expect(t.spentToday()).toBeCloseTo(0.75, 10);
    vi.useRealTimers();
  });

  it("ignores malformed lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
    const file = tmpTrackFile();
    const t = makeTracker({ trackFile: file });
    t.record({
      timestamp: "2026-04-07T01:00:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.5,
    });
    // Corrupt the log with garbage that CostTracker should skip.
    appendFileSync(file, "not-json\n{broken\n");
    expect(t.spentToday()).toBeCloseTo(0.5, 10);
    vi.useRealTimers();
  });
});

describe("CostTracker.wouldExceedDaily", () => {
  it("returns true when sum exceeds the daily cap", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
    const t = makeTracker({ maxDailyUsd: 1.0 });
    t.record({
      timestamp: "2026-04-07T01:00:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.8,
    });
    expect(t.wouldExceedDaily(0.3)).toBe(true);
    expect(t.wouldExceedDaily(0.1)).toBe(false);
    vi.useRealTimers();
  });
});

describe("CostTracker.checkOperationBudget", () => {
  it("returns null when under all caps", () => {
    const t = makeTracker();
    expect(t.checkOperationBudget("ingest", 0.5)).toBeNull();
    expect(t.checkOperationBudget("query", 0.1)).toBeNull();
  });

  it("rejects an ingest over per-ingest cap", () => {
    const t = makeTracker({ maxPerIngestUsd: 0.5 });
    const err = t.checkOperationBudget("ingest", 1.0);
    expect(err).toContain("exceeds per-ingest cap");
  });

  it("rejects a query over per-query cap", () => {
    const t = makeTracker({ maxPerQueryUsd: 0.1 });
    const err = t.checkOperationBudget("query", 0.5);
    expect(err).toContain("exceeds per-query cap");
  });

  it("rejects when daily cap would be exceeded", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T12:00:00.000Z"));
    const t = makeTracker({ maxDailyUsd: 1.0, maxPerIngestUsd: 10 });
    t.record({
      timestamp: "2026-04-07T01:00:00.000Z",
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.95,
    });
    const err = t.checkOperationBudget("ingest", 0.2);
    expect(err).toContain("daily cap");
    vi.useRealTimers();
  });
});

describe("CostTracker.logUsage", () => {
  it("wraps record() with a generated timestamp", () => {
    const file = tmpTrackFile();
    const t = makeTracker({ trackFile: file });
    t.logUsage({
      operation: "ingest",
      model: "claude-haiku-4-5",
      costUsd: 0.02,
      inputTokens: 100,
      outputTokens: 50,
    });
    const parsed = JSON.parse(readFileSync(file, "utf8").trim());
    expect(parsed.operation).toBe("ingest");
    expect(parsed.input_tokens).toBe(100);
    expect(parsed.output_tokens).toBe(50);
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
