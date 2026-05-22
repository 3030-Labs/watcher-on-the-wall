/**
 * Tests for CRITICAL-1: Search index health pre-flight in QueryEngine.
 *
 * When the wiki has pages but the search index is empty (e.g. after a failed
 * rebuild), the engine should return a skipped result with a "rebuild required"
 * reason rather than proceeding to the LLM with zero context.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/daemon/config.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";

// Mock external dependencies that the QueryEngine calls during answer().
// Post Phase 3, the engine dispatches through runtimeAwareComplete.
vi.mock("../../src/llm/runtime-aware.js", () => ({
  runtimeAwareComplete: vi.fn(),
}));
vi.mock("../../src/server/query-expansion.js", () => ({
  expandQuery: vi
    .fn()
    .mockResolvedValue({ expanded: false, expandedQuery: "", expansionTerms: [], costUsd: 0 }),
}));
vi.mock("../../src/server/query-metrics.js", () => ({
  recordQueryOutcome: vi.fn(),
}));

import { QueryEngine } from "../../src/server/query-engine.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-qe-health-"));
}

function makeEngine(searchSize: number, storeCount: number): QueryEngine {
  const dir = tmp();
  const config = {
    ...defaultConfig(),
    wiki_root: dir,
  };
  const costTracker = new CostTracker({
    trackFile: join(dir, "cost.jsonl"),
    maxDailyUsd: 10,
    maxPerIngestUsd: 2,
    maxPerQueryUsd: 0.5,
  });
  const modelRouter = new ModelRouter(config);

  // Minimal mocks that implement only the methods QueryEngine calls.
  const search = {
    size: () => searchSize,
    search: () => [],
    rebuild: () => {},
    upsert: () => {},
    remove: () => {},
  };
  const store = {
    count: () => storeCount,
    listAll: () => [],
    relativePath: (p: string) => p,
  };

  return new QueryEngine({
    config,
    store: store as never,
    search: search as never,
    costTracker,
    modelRouter,
    runtimeMode: "api",
  });
}

describe("QueryEngine search index health pre-flight", () => {
  it("returns skipped=true with rebuild reason when store has pages but search is empty", async () => {
    const engine = makeEngine(0, 5); // search empty, store has 5 pages
    const result = await engine.answer("What is X?");

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("rebuild");
    expect(result.skipReason).toContain("search index is empty");
    expect(result.answer).toBe("");
    expect(result.sources).toEqual([]);
    expect(result.costUsd).toBe(0);
  });

  it("returns normal zero-hit response when both store and search are empty", async () => {
    const engine = makeEngine(0, 0); // both empty — fresh wiki
    const result = await engine.answer("What is X?");

    // Should NOT get the "rebuild required" skip — this is just an empty wiki.
    expect(result.skipReason).toBeUndefined();
    expect(result.skipped).toBe(false);
    expect(result.answer).toContain("No relevant wiki pages");
  });
});
