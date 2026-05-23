/**
 * Unit tests for query_progressive (Feature Pass 005).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ProgressiveCache } from "../../../src/server/progressive-cache.js";
import {
  queryProgressive,
  queryExpand,
  TIER_LABELS,
  MAX_TIER,
} from "../../../src/server/progressive-query.js";
import { CHARS_PER_TOKEN } from "../../../src/server/token-estimator.js";
import { loadSmallCorpus, makeMiniWiki } from "./test-helpers.js";

describe("query_progressive: happy path", () => {
  it("returns tier-0 lede with a continuation_token", async () => {
    const wiki = makeMiniWiki();
    // Small corpus (10+ pages) ensures BM25 surfaces multiple hits so the
    // tier-0 → tier-1 escalation path is reachable.
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const result = await queryProgressive("photosynthesis chlorophyll", {
      store: wiki.store,
      search: wiki.search,
      cache,
    });

    expect(result.tier).toBe(0);
    expect(result.tier_label).toBe(TIER_LABELS[0]);
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.has_more).toBe(true);
    expect(result.continuation_token).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.hit_count_total).toBe(1);
    expect(result.tokens_delivered).toBeGreaterThan(0);
    expect(result.next_tier_label).toBe(TIER_LABELS[1]);
  });
});

describe("query_progressive: empty-corpus path", () => {
  it("returns no-content response when corpus is empty", async () => {
    const wiki = makeMiniWiki();
    const cache = new ProgressiveCache();

    const result = await queryProgressive("anything", {
      store: wiki.store,
      search: wiki.search,
      cache,
    });
    expect(result.has_more).toBe(false);
    expect(result.continuation_token).toBeNull();
    expect(result.content).toContain("no matching pages");
  });
});

describe("query_progressive: token-budget enforcement", () => {
  it("tier-0 payload never exceeds max_tokens_initial", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const budget = 80;
    const result = await queryProgressive("rust borrow checker", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: budget,
      maxTokensTotal: 8192,
    });
    expect(result.tokens_delivered).toBeLessThanOrEqual(budget);
    expect(result.content.length).toBeLessThanOrEqual(budget * CHARS_PER_TOKEN);
  });

  it("max_tokens_total caps cumulative shipped tokens across expand calls", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const total = 256;
    let result = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: 100,
      maxTokensTotal: total,
    });
    let cumulative = result.tokens_shipped_total;
    expect(cumulative).toBeLessThanOrEqual(total);

    while (result.has_more && result.continuation_token) {
      const next = await queryExpand(result.continuation_token, {
        cache,
        additionalTokens: 200,
      });
      if ("error" in next) break;
      cumulative = next.tokens_shipped_total;
      expect(cumulative).toBeLessThanOrEqual(total);
      result = next;
    }
  });
});

describe("query_progressive: tier escalation", () => {
  it("can walk all four tiers via repeated expand", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    let result = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: 256,
      maxTokensTotal: 16384,
    });
    expect(result.tier).toBe(0);

    const seen = [result.tier];
    while (result.has_more && result.continuation_token && result.tier < MAX_TIER) {
      const next = await queryExpand(result.continuation_token, {
        cache,
        additionalTokens: 4096,
      });
      if ("error" in next) throw new Error(next.error);
      seen.push(next.tier);
      result = next;
    }
    // Every tier from 0 up through MAX_TIER should have been served at least once.
    expect(seen).toContain(0);
    expect(seen).toContain(1);
    expect(seen).toContain(2);
    expect(seen).toContain(3);
  });
});

describe("query_progressive: malformed input rejection", () => {
  it("zero / negative initial budget falls back to default", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();
    const result = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: 0,
      maxTokensTotal: 8192,
    });
    expect(result.tokens_delivered).toBeGreaterThan(0);
  });
});

describe("query_progressive: BM25-only regression guard", () => {
  // If a future refactor introduces a vector / embedding fallback, this
  // test breaks loudly. We scan for actual import statements + library
  // names — prose containing "embedding" (e.g., comments documenting the
  // BM25-only commitment) is fine.
  it("progressive-query.ts source contains no vector/embedding imports", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "server", "progressive-query.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /import[^;]+(?:@xenova|sentence-transformers|chromadb|pinecone|weaviate|faiss|hnswlib)/i,
    );
    expect(src).not.toMatch(/cosineSimilarity\s*\(/);
    expect(src).not.toMatch(/\.embed\s*\(/);
    expect(src).toMatch(/WikiSearch/); // sanity: still uses BM25
  });
});
