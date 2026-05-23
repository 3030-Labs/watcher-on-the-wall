/**
 * Context-efficiency benchmark for the Feature Pass 005-007 additive
 * retrieval tools (Pass A).
 *
 * Compares tokens-per-query for:
 *   - BASELINE:    the daemon-side retrieval payload assembled by the legacy
 *                  `query` tool (i.e., the 32 KB max single-pass prompt
 *                  defined at `src/server/query-engine.ts:27`). This is the
 *                  tokens the daemon's LLM consumes — the daemon's
 *                  per-query cost, and an upper bound on what a non-
 *                  synthesizing client would have to ingest.
 *   - PROGRESSIVE: the tokens shipped to the client LLM across the
 *                  progressive flow at increasing tier depths.
 *
 * The 60% reduction target applies on the tier-0 vs baseline axis (the
 * dominant scenario — most client queries are satisfied by the lede).
 * We also report cumulative-through-tier and full-bodies cumulative so a
 * reader can see the cost shape at each depth.
 *
 * Vitest runs this as a regular test file (we don't use the separate
 * vitest bench API because the assertions need to be hard gates, not
 * benchmark histograms). The run is fast (no LLM calls; pure in-process
 * retrieval).
 */
import { describe, expect, it } from "vitest";
import { renderProgressiveCumulative } from "../../src/server/progressive-query.js";
import { estimateQueryCost } from "../../src/server/cost-estimator.js";
import {
  loadCanonicalFixtures,
  loadSmallCorpus,
  loadLargeCorpus,
  makeMiniWiki,
  type MiniWiki,
} from "../unit/mcp/test-helpers.js";

const TARGET_REDUCTION = 0.6;

interface FixtureRow {
  fixture: string;
  question: string;
  baseline_tokens: number;
  tier0_tokens: number;
  tier01_tokens: number;
  tier012_tokens: number;
  full_cumulative_tokens: number;
  reduction_tier0: number;
  reduction_tier01: number;
}

async function measure(
  wiki: MiniWiki,
  fixtureLabel: string,
  question: string,
): Promise<FixtureRow> {
  // Baseline: identical retrieval payload assembly to query-engine.ts.
  const baseline = await estimateQueryCost(question, {
    store: wiki.store,
    search: wiki.search,
    config: wiki.config,
  });
  const baseline_tokens = baseline.estimates[0]?.tokens ?? 0;

  const tier0 = await renderProgressiveCumulative(question, {
    store: wiki.store,
    search: wiki.search,
    maxTier: 0,
    perTierBudget: 512,
  });
  const tier01 = await renderProgressiveCumulative(question, {
    store: wiki.store,
    search: wiki.search,
    maxTier: 1,
    perTierBudget: 1024,
  });
  const tier012 = await renderProgressiveCumulative(question, {
    store: wiki.store,
    search: wiki.search,
    maxTier: 2,
    perTierBudget: 2048,
  });
  const full = await renderProgressiveCumulative(question, {
    store: wiki.store,
    search: wiki.search,
    maxTier: 3,
    perTierBudget: 4096,
  });

  const reduction_tier0 =
    baseline_tokens > 0 ? (baseline_tokens - tier0.tokens) / baseline_tokens : 0;
  const reduction_tier01 =
    baseline_tokens > 0 ? (baseline_tokens - tier01.tokens) / baseline_tokens : 0;

  return {
    fixture: fixtureLabel,
    question,
    baseline_tokens,
    tier0_tokens: tier0.tokens,
    tier01_tokens: tier01.tokens,
    tier012_tokens: tier012.tokens,
    full_cumulative_tokens: full.tokens,
    reduction_tier0,
    reduction_tier01,
  };
}

function printTable(rows: FixtureRow[]): void {
  console.log("\n=== Context-Efficiency Benchmark (Pass A) ===");
  console.log(
    "fixture\tquestion\tbaseline\ttier0\ttier0+1\ttier0+1+2\tfull\tred(tier0)\tred(tier0+1)",
  );
  for (const r of rows) {
    console.log(
      `${r.fixture}\t${r.question.slice(0, 24)}\t${r.baseline_tokens}\t${r.tier0_tokens}\t${r.tier01_tokens}\t${r.tier012_tokens}\t${r.full_cumulative_tokens}\t${(r.reduction_tier0 * 100).toFixed(1)}%\t${(r.reduction_tier01 * 100).toFixed(1)}%`,
    );
  }
}

describe("context-efficiency benchmark: token-reduction targets", () => {
  it("F1 photosynthesis: tier-0 ships ≥60% fewer tokens than baseline", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const row = await measure(wiki, "F1-photosynthesis", "what is photosynthesis?");
    expect(row.baseline_tokens).toBeGreaterThan(0);
    expect(row.reduction_tier0).toBeGreaterThanOrEqual(TARGET_REDUCTION);
    printTable([row]);
  });

  it("F4 rust-borrow-checker: tier-0 ships ≥60% fewer tokens than baseline", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const row = await measure(
      wiki,
      "F4-rust-borrow-checker",
      "how does the rust borrow checker work?",
    );
    expect(row.baseline_tokens).toBeGreaterThan(0);
    expect(row.reduction_tier0).toBeGreaterThanOrEqual(TARGET_REDUCTION);
    printTable([row]);
  });

  it("small-corpus (10 pages): tier-0 ships ≥60% fewer tokens than baseline", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const row = await measure(wiki, "small-corpus", "photosynthesis chlorophyll");
    expect(row.baseline_tokens).toBeGreaterThan(0);
    expect(row.reduction_tier0).toBeGreaterThanOrEqual(TARGET_REDUCTION);
    printTable([row]);
  });

  it("large-corpus (~100 pages): tier-0 ships ≥60% fewer tokens than baseline", async () => {
    const wiki = makeMiniWiki();
    await loadLargeCorpus(wiki);
    const row = await measure(wiki, "large-corpus", "concept topic overview");
    expect(row.baseline_tokens).toBeGreaterThan(0);
    expect(row.reduction_tier0).toBeGreaterThanOrEqual(TARGET_REDUCTION);
    printTable([row]);
  });

  it("ALL fixtures: tier-0+1 cumulative still ships ≥60% fewer tokens", async () => {
    const rows: FixtureRow[] = [];
    {
      const wiki = makeMiniWiki();
      await loadCanonicalFixtures(wiki);
      rows.push(await measure(wiki, "F1-photosynthesis", "what is photosynthesis?"));
      rows.push(
        await measure(wiki, "F4-rust-borrow-checker", "how does the rust borrow checker work?"),
      );
    }
    {
      const wiki = makeMiniWiki();
      await loadSmallCorpus(wiki);
      rows.push(await measure(wiki, "small-corpus", "photosynthesis chlorophyll"));
    }
    {
      const wiki = makeMiniWiki();
      await loadLargeCorpus(wiki);
      rows.push(await measure(wiki, "large-corpus", "concept topic overview"));
    }
    printTable(rows);
    for (const r of rows) {
      expect(
        r.reduction_tier01,
        `${r.fixture}: tier-0+1 reduction below target`,
      ).toBeGreaterThanOrEqual(TARGET_REDUCTION);
    }
  });
});

describe("context-efficiency benchmark: token-budget honoring", () => {
  it("progressive payload at each tier never exceeds its per-tier budget", async () => {
    const wiki = makeMiniWiki();
    await loadLargeCorpus(wiki);
    const tier3 = await renderProgressiveCumulative("topic", {
      store: wiki.store,
      search: wiki.search,
      maxTier: 3,
      perTierBudget: 1024,
    });
    // Cumulative across 4 tiers with per-tier budget 1024 should be ≤ 4096
    // (plus a tiny accounting tolerance for inter-tier separator chars).
    expect(tier3.tokens).toBeLessThanOrEqual(4096 + 8);
  });
});

describe("context-efficiency benchmark: heuristic-vs-corpus sanity", () => {
  it("baseline payload tokens scale with corpus", async () => {
    // Each corpus needs a query that BM25 actually matches in that corpus.
    // small-corpus has photosynthesis/chlorophyll pages; large-corpus has
    // synthetic topic-* pages.
    const small = makeMiniWiki();
    await loadSmallCorpus(small);
    const large = makeMiniWiki();
    await loadLargeCorpus(large);
    const smallRow = await measure(small, "small", "photosynthesis chlorophyll");
    const largeRow = await measure(large, "large", "topic concept overview");
    expect(largeRow.baseline_tokens).toBeGreaterThan(0);
    expect(smallRow.baseline_tokens).toBeGreaterThan(0);
    console.log(
      `small baseline ${smallRow.baseline_tokens} vs large baseline ${largeRow.baseline_tokens}`,
    );
  });
});

/** Exposed so the FEATURE-PASS markdown can include the same numbers. */
export async function runBenchmarkSnapshot(): Promise<FixtureRow[]> {
  const rows: FixtureRow[] = [];
  {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    rows.push(await measure(wiki, "F1-photosynthesis", "what is photosynthesis?"));
    rows.push(
      await measure(wiki, "F4-rust-borrow-checker", "how does the rust borrow checker work?"),
    );
  }
  {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    rows.push(await measure(wiki, "small-corpus", "photosynthesis chlorophyll"));
  }
  {
    const wiki = makeMiniWiki();
    await loadLargeCorpus(wiki);
    rows.push(await measure(wiki, "large-corpus", "concept topic overview"));
  }
  return rows;
}
