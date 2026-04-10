/**
 * Integration test for the compounding engine's skip paths — everything the
 * engine does BEFORE invoking the LLM agent. We can validate:
 *
 *   - Config disable path (compounding.enabled = false)
 *   - Not-enough-pages path (< min_source_pages)
 *   - Budget-exceeded path
 *   - Existing-synthesis cluster skip
 *
 * The synthesis-cluster LLM invocation is the only path we can't test here;
 * it runs in the live Gate 4 verification instead.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompoundingEngine } from "../../src/compounding/engine.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage } from "../../src/wiki/page.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-compound-"));
}

async function makeRig(configOverrides: (cfg: WotwConfig) => void = () => undefined): Promise<{
  engine: CompoundingEngine;
  store: WikiStore;
  search: WikiSearch;
  indexManager: IndexManager;
  costTracker: CostTracker;
  root: string;
  config: WotwConfig;
}> {
  const root = tmpRoot();
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.multi_user.workspaces_dir = join(root, "workspaces");
  configOverrides(cfg);
  const config = resolveConfigPaths(cfg);

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  await store.ensureLayout();
  const indexManager = new IndexManager(store);
  const search = new WikiSearch();
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: config.cost.max_daily_usd,
    maxPerIngestUsd: config.cost.max_per_ingest_usd,
    maxPerQueryUsd: config.cost.max_per_query_usd,
  });
  const modelRouter = new ModelRouter(config);

  const engine = new CompoundingEngine({
    config,
    store,
    indexManager,
    search,
    costTracker,
    modelRouter,
  });
  return { engine, store, search, indexManager, costTracker, root, config };
}

describe("CompoundingEngine.synthesize (skip paths)", () => {
  it("skips when compounding is disabled in config", async () => {
    const { engine } = await makeRig((cfg) => {
      cfg.compounding.enabled = false;
    });
    const out = await engine.synthesize();
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toContain("disabled");
    expect(out.pagesWritten).toBe(0);
  });

  it("skips when wiki has fewer pages than min_source_pages", async () => {
    const { engine, store } = await makeRig((cfg) => {
      cfg.compounding.min_source_pages = 3;
    });
    // Only write 2 pages.
    await store.writePage(
      newPage(store.pathFor("concept", "a"), "A", "concept", "body", { tags: ["t1"] }),
    );
    await store.writePage(
      newPage(store.pathFor("concept", "b"), "B", "concept", "body", { tags: ["t1"] }),
    );
    const out = await engine.synthesize();
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toContain("minimum is 3");
  });

  it("skips when the daily budget is already exhausted", async () => {
    const { engine, costTracker } = await makeRig((cfg) => {
      cfg.cost.max_daily_usd = 0.001;
      cfg.compounding.min_source_pages = 1;
    });
    // Max out the budget.
    costTracker.record({
      timestamp: new Date().toISOString(),
      operation: "ingest",
      model_id: "claude-haiku-4-5",
      cost_usd: 0.1,
    });
    const out = await engine.synthesize();
    expect(out.skipped).toBe(true);
    expect(out.skipReason).toContain("budget");
  });

  it("reports zero clusters when no tag meets the minimum size", async () => {
    const { engine, store } = await makeRig((cfg) => {
      cfg.compounding.min_source_pages = 3;
    });
    // Write enough pages but each with distinct tags.
    await store.writePage(
      newPage(store.pathFor("concept", "a"), "A", "concept", "body", { tags: ["t1"] }),
    );
    await store.writePage(
      newPage(store.pathFor("concept", "b"), "B", "concept", "body", { tags: ["t2"] }),
    );
    await store.writePage(
      newPage(store.pathFor("concept", "c"), "C", "concept", "body", { tags: ["t3"] }),
    );
    const out = await engine.synthesize();
    // Not skipped outright (it passed min_source_pages), but no clusters formed.
    expect(out.skipped).toBe(false);
    expect(out.clusters).toHaveLength(0);
    expect(out.pagesWritten).toBe(0);
  });
});
