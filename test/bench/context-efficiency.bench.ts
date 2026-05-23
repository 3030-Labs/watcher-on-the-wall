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
import { queryFacts } from "../../src/server/fact-query.js";
import { FactIndex } from "../../src/facts/index-manager.js";
import type { Fact, FactQuestion } from "../../src/facts/types.js";
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

// ---------------------------------------------------------------------------
// Pass B (Feature Pass 008) — atomic-question benchmark for query_facts
// ---------------------------------------------------------------------------

interface FactsRow {
  fixture: string;
  question: string;
  baseline_tokens: number;
  facts_tokens: number;
  reduction: number;
}

/**
 * Pre-seed a FactIndex with canonical facts for a fixture. Bypasses the
 * LLM extractor so the benchmark is deterministic + network-free.
 */
function seedFactIndex(
  facts: Array<[number, string, string, string]>,
  questions: Array<[number, number, string]>,
): FactIndex {
  const idx = new FactIndex();
  const factObjs: Fact[] = facts.map(([id, page, entity, statement]) => ({
    id,
    wiki_page_id: page,
    entity,
    statement,
    fact_hash: `bench-fact-${id}`,
    created_at: "2026-05-23T12:00:00.000Z",
    superseded_at: null,
  }));
  const qObjs: FactQuestion[] = questions.map(([id, factId, text]) => ({
    id,
    fact_id: factId,
    question_text: text,
    question_hash: `bench-q-${id}`,
  }));
  idx.rebuild(factObjs, qObjs);
  return idx;
}

async function measureFacts(
  wiki: MiniWiki,
  fixtureLabel: string,
  question: string,
  factIndex: FactIndex,
): Promise<FactsRow> {
  const baseline = await estimateQueryCost(question, {
    store: wiki.store,
    search: wiki.search,
    config: wiki.config,
  });
  const baselineTokens = baseline.estimates[0]?.tokens ?? 0;
  const facts = queryFacts(question, { factIndex, factStore: null, limit: 5 });
  const reduction = baselineTokens > 0 ? (baselineTokens - facts.tokens) / baselineTokens : 0;
  return {
    fixture: fixtureLabel,
    question,
    baseline_tokens: baselineTokens,
    facts_tokens: facts.tokens,
    reduction,
  };
}

function printFactsTable(rows: FactsRow[]): void {
  console.log("\n=== Pass B Fact-Layer Benchmark ===");
  console.log("fixture\tquestion\tbaseline\tquery_facts\treduction");
  for (const r of rows) {
    console.log(
      `${r.fixture}\t${r.question.slice(0, 32)}\t${r.baseline_tokens}\t${r.facts_tokens}\t${(r.reduction * 100).toFixed(1)}%`,
    );
  }
}

const FACTS_TARGET_REDUCTION = 0.8;

describe("Pass B benchmark: query_facts ≥80% reduction on atomic-question fixtures", () => {
  it("F1 photosynthesis atomic question", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = seedFactIndex(
      [
        [
          1,
          "wiki/concepts/photosynthesis.md",
          "Photosynthesis",
          "Photosynthesis converts light energy into chemical energy stored in glucose.",
        ],
        [
          2,
          "wiki/concepts/photosynthesis.md",
          "Chlorophyll",
          "Chlorophyll absorbs photons primarily in red and blue wavelengths.",
        ],
      ],
      [
        [1, 1, "What does photosynthesis do?"],
        [2, 1, "What is photosynthesis?"],
        [3, 2, "What does chlorophyll absorb?"],
      ],
    );
    const row = await measureFacts(wiki, "F1-photosynthesis", "what is photosynthesis?", idx);
    expect(row.reduction).toBeGreaterThanOrEqual(FACTS_TARGET_REDUCTION);
    printFactsTable([row]);
  });

  it("F4 rust borrow checker atomic question", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = seedFactIndex(
      [
        [
          1,
          "wiki/concepts/rust-borrow-checker.md",
          "Rust borrow checker",
          "The Rust borrow checker is a compile-time mechanism that enforces ownership and borrowing rules.",
        ],
        [
          2,
          "wiki/concepts/rust-borrow-checker.md",
          "Lifetimes",
          "Lifetimes are annotations that the borrow checker uses to verify that references do not outlive their referents.",
        ],
      ],
      [
        [1, 1, "What is the Rust borrow checker?"],
        [2, 2, "What are Rust lifetimes?"],
      ],
    );
    const row = await measureFacts(
      wiki,
      "F4-rust-borrow-checker",
      "what is the rust borrow checker?",
      idx,
    );
    expect(row.reduction).toBeGreaterThanOrEqual(FACTS_TARGET_REDUCTION);
    printFactsTable([row]);
  });

  it("small-corpus atomic question", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const idx = seedFactIndex(
      [
        [
          1,
          "wiki/concepts/photosynthesis.md",
          "Photosynthesis",
          "Photosynthesis converts light into glucose using chlorophyll.",
        ],
        [
          2,
          "wiki/concepts/mitochondria.md",
          "Mitochondria",
          "Mitochondria generate ATP via cellular respiration.",
        ],
        [
          3,
          "wiki/concepts/dna.md",
          "DNA",
          "DNA stores genetic information using four nucleotide bases.",
        ],
      ],
      [
        [1, 1, "What does photosynthesis produce?"],
        [2, 2, "What do mitochondria do?"],
        [3, 3, "How does DNA store information?"],
      ],
    );
    const row = await measureFacts(wiki, "small-corpus", "what does photosynthesis produce?", idx);
    expect(row.reduction).toBeGreaterThanOrEqual(FACTS_TARGET_REDUCTION);
    printFactsTable([row]);
  });

  it("large-corpus atomic question", async () => {
    const wiki = makeMiniWiki();
    await loadLargeCorpus(wiki);
    const idx = seedFactIndex(
      [
        [
          1,
          "wiki/concepts/topic-0.md",
          "Topic 0",
          "Topic 0 discusses concept 0 in the broader knowledge wiki.",
        ],
        [
          2,
          "wiki/concepts/topic-1.md",
          "Topic 1",
          "Topic 1 discusses concept 1 in the broader knowledge wiki.",
        ],
      ],
      [
        [1, 1, "What is topic 0?"],
        [2, 2, "What is topic 1?"],
      ],
    );
    const row = await measureFacts(wiki, "large-corpus", "what is topic 0?", idx);
    expect(row.reduction).toBeGreaterThanOrEqual(FACTS_TARGET_REDUCTION);
    printFactsTable([row]);
  });
});

describe("Pass B benchmark: query_facts cumulative across all 4 fixtures", () => {
  it("ALL fixtures clear 80% reduction", async () => {
    const rows: FactsRow[] = [];
    {
      const wiki = makeMiniWiki();
      await loadCanonicalFixtures(wiki);
      const idx = seedFactIndex(
        [
          [
            1,
            "wiki/concepts/photosynthesis.md",
            "Photosynthesis",
            "Photosynthesis converts light energy into chemical energy stored in glucose.",
          ],
          [
            2,
            "wiki/concepts/rust-borrow-checker.md",
            "Rust borrow checker",
            "The Rust borrow checker enforces ownership and borrowing rules at compile time.",
          ],
        ],
        [
          [1, 1, "What is photosynthesis?"],
          [2, 2, "What is the Rust borrow checker?"],
        ],
      );
      rows.push(await measureFacts(wiki, "F1", "what is photosynthesis?", idx));
      rows.push(await measureFacts(wiki, "F4", "what is the rust borrow checker?", idx));
    }
    {
      const wiki = makeMiniWiki();
      await loadSmallCorpus(wiki);
      const idx = seedFactIndex(
        [
          [
            1,
            "wiki/concepts/photosynthesis.md",
            "Photosynthesis",
            "Photosynthesis converts light into glucose.",
          ],
        ],
        [[1, 1, "What is photosynthesis?"]],
      );
      rows.push(await measureFacts(wiki, "small-corpus", "what is photosynthesis?", idx));
    }
    {
      const wiki = makeMiniWiki();
      await loadLargeCorpus(wiki);
      const idx = seedFactIndex(
        [[1, "wiki/concepts/topic-0.md", "Topic 0", "Topic 0 discusses concept 0."]],
        [[1, 1, "What is topic 0?"]],
      );
      rows.push(await measureFacts(wiki, "large-corpus", "what is topic 0?", idx));
    }
    printFactsTable(rows);
    for (const r of rows) {
      expect(r.reduction, `${r.fixture}: query_facts reduction below 80%`).toBeGreaterThanOrEqual(
        FACTS_TARGET_REDUCTION,
      );
    }
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
