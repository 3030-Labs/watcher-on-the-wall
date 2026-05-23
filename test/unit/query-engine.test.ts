/**
 * Unit tests for the query engine zero-hit grounding guard.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { newPage, serializePage } from "../../src/wiki/page.js";
import { loadAllPages } from "../../src/ingestion/wiki-writer.js";
import { QueryEngine } from "../../src/server/query-engine.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-qe-"));
}

function setupStore(wikiRoot: string): WikiStore {
  const store = new WikiStore({ wikiRoot });
  mkdirSync(join(wikiRoot, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "entities"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "sources"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "comparisons"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "syntheses"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "queries"), { recursive: true });
  return store;
}

// Minimal mock objects sufficient for testing the zero-hit path
// (which never calls the LLM).
function mockCostTracker(): {
  wouldExceedDaily: () => boolean;
  logUsage: () => void;
  checkOperationBudget: () => string | null;
} {
  return {
    wouldExceedDaily: () => false,
    logUsage: () => {},
    // Review item 22 + 36: query-engine + queue now invoke
    // checkOperationBudget; mock returns null = "no budget block".
    checkOperationBudget: () => null,
  };
}

function mockModelRouter(): { modelFor: () => string; computeCost: () => number } {
  return {
    modelFor: () => "claude-haiku-4-5",
    computeCost: () => 0,
  };
}

describe("QueryEngine zero-hit grounding guard", () => {
  it("returns 'no relevant pages' for empty wiki", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();
    const config = resolveConfigPaths(defaultConfig(), root);
    config.wiki_root = root;
    config.query.expand = false;

    const engine = new QueryEngine({
      config,
      store,
      search,
      costTracker: mockCostTracker() as never,
      modelRouter: mockModelRouter() as never,
    });

    const result = await engine.answer("what is a hash chain?");
    expect(result.answer).toContain("No relevant wiki pages found");
    expect(result.sources).toEqual([]);
    expect(result.costUsd).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("returns 'no relevant pages' for unmatched query against populated wiki", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();

    // Add a page about cooking — won't match a crypto query.
    const page = newPage(
      join(root, "wiki", "concepts", "pasta.md"),
      "Italian Pasta",
      "concept",
      "How to cook perfect pasta al dente.",
    );
    writeFileSync(page.path, serializePage(page));
    const allPages = await loadAllPages(store);
    search.rebuild(allPages);

    const config = resolveConfigPaths(defaultConfig(), root);
    config.wiki_root = root;
    // Disable query expansion so the zero-hit test isn't polluted by
    // expansion terms matching irrelevant pages.
    config.query.expand = false;

    const engine = new QueryEngine({
      config,
      store,
      search,
      costTracker: mockCostTracker() as never,
      modelRouter: mockModelRouter() as never,
    });

    const result = await engine.answer("quantum entanglement physics");
    expect(result.answer).toContain("No relevant wiki pages found");
    expect(result.costUsd).toBe(0);
  });
});
