/**
 * Tests for Feature 4: Zero-hit monitoring and vocabulary enrichment.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeZeroHitRate, recordQueryOutcome } from "../../src/server/query-metrics.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-qm-"));
}

describe("computeZeroHitRate", () => {
  it("returns zeros with no log file", () => {
    const result = computeZeroHitRate("/nonexistent/file.jsonl");
    expect(result.total_queries).toBe(0);
    expect(result.zero_hits).toBe(0);
    expect(result.zero_hit_rate).toBe(0);
    expect(result.recent_zero_hit_queries).toEqual([]);
  });

  it("returns zeros with empty string path", () => {
    const result = computeZeroHitRate("");
    expect(result.total_queries).toBe(0);
    expect(result.zero_hit_rate).toBe(0);
  });

  it("computes correct rate with mixed results", () => {
    const dir = tmp();
    const file = join(dir, "query-log.jsonl");
    const now = new Date().toISOString();
    const lines = [
      JSON.stringify({ timestamp: now, query: "deploy", zero_hit: false, citations: 3 }),
      JSON.stringify({ timestamp: now, query: "quantum", zero_hit: true, citations: 0 }),
      JSON.stringify({ timestamp: now, query: "auth", zero_hit: false, citations: 5 }),
      JSON.stringify({ timestamp: now, query: "wormholes", zero_hit: true, citations: 0 }),
      JSON.stringify({ timestamp: now, query: "testing", zero_hit: false, citations: 2 }),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const result = computeZeroHitRate(file);
    expect(result.total_queries).toBe(5);
    expect(result.zero_hits).toBe(2);
    expect(result.zero_hit_rate).toBeCloseTo(0.4, 5);
    expect(result.recent_zero_hit_queries).toEqual(["quantum", "wormholes"]);
  });

  it("filters to the 7-day window", () => {
    const dir = tmp();
    const file = join(dir, "query-log.jsonl");
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(); // 14 days ago
    const lines = [
      JSON.stringify({ timestamp: old, query: "old-query", zero_hit: true, citations: 0 }),
      JSON.stringify({ timestamp: now, query: "new-query", zero_hit: true, citations: 0 }),
    ];
    writeFileSync(file, lines.join("\n") + "\n", "utf8");

    const result = computeZeroHitRate(file, 7);
    expect(result.total_queries).toBe(1); // only the recent one
    expect(result.zero_hits).toBe(1);
    expect(result.recent_zero_hit_queries).toEqual(["new-query"]);
  });

  it("skips malformed lines gracefully", () => {
    const dir = tmp();
    const file = join(dir, "query-log.jsonl");
    const now = new Date().toISOString();
    writeFileSync(
      file,
      [
        "not json at all",
        JSON.stringify({ timestamp: now, query: "valid", zero_hit: false, citations: 1 }),
        "{{{corrupt",
      ].join("\n") + "\n",
      "utf8",
    );

    const result = computeZeroHitRate(file);
    expect(result.total_queries).toBe(1);
    expect(result.zero_hits).toBe(0);
  });
});

describe("recordQueryOutcome", () => {
  it("appends a line to the query log", () => {
    const dir = tmp();
    const file = join(dir, "query-log.jsonl");
    recordQueryOutcome(file, "test query", 3);
    const raw = readFileSync(file, "utf8");
    const entry = JSON.parse(raw.trim());
    expect(entry.query).toBe("test query");
    expect(entry.zero_hit).toBe(false);
    expect(entry.citations).toBe(3);
    expect(entry.timestamp).toBeDefined();
  });

  it("records zero-hit correctly", () => {
    const dir = tmp();
    const file = join(dir, "query-log.jsonl");
    recordQueryOutcome(file, "missing topic", 0);
    const raw = readFileSync(file, "utf8");
    const entry = JSON.parse(raw.trim());
    expect(entry.zero_hit).toBe(true);
    expect(entry.citations).toBe(0);
  });

  it("does nothing with empty path", () => {
    // Should not throw.
    recordQueryOutcome("", "test", 0);
    // Verify no file was created at the empty path -- the function short-circuits on empty string.
    expect(existsSync("")).toBe(false);
  });
});

describe("vocabulary enrichment", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("skips when enrichment is disabled", async () => {
    vi.doMock("../../src/ingestion/llm-invoker.js", () => ({
      invokeIngestionAgent: vi.fn(),
    }));
    vi.doMock("../../src/ingestion/git-committer.js", () => ({
      commitWikiChanges: vi.fn().mockResolvedValue({ committed: true, sha: "abc" }),
    }));

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const { defaultConfig } = await import("../../src/daemon/config.js");
    const { WikiStore } = await import("../../src/wiki/store.js");
    const { WikiSearch } = await import("../../src/wiki/search.js");
    const { CostTracker } = await import("../../src/ingestion/cost-tracker.js");
    const { ModelRouter } = await import("../../src/ingestion/model-router.js");

    const dir = tmp();
    const config = { ...defaultConfig(), wiki_root: dir };
    config.health.enrichment_enabled = false;

    const result = await runVocabularyEnrichment({
      config,
      store: new WikiStore({ wikiRoot: dir }),
      search: new WikiSearch(),
      provenance: null,
      costTracker: new CostTracker({
        trackFile: join(dir, "cost.jsonl"),
        maxDailyUsd: 10,
        maxPerIngestUsd: 2,
        maxPerQueryUsd: 0.5,
      }),
      modelRouter: new ModelRouter(config),
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("disabled");
  });
});
