/**
 * Unit tests for query_expand (Feature Pass 005).
 */
import { describe, expect, it } from "vitest";
import { ProgressiveCache } from "../../../src/server/progressive-cache.js";
import { queryProgressive, queryExpand } from "../../../src/server/progressive-query.js";
import { CHARS_PER_TOKEN } from "../../../src/server/token-estimator.js";
import { loadSmallCorpus, makeMiniWiki } from "./test-helpers.js";

describe("query_expand: happy path", () => {
  it("returns tier-1 delta on first expand after tier-0 progressive", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const initial = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: 256,
    });
    expect(initial.continuation_token).not.toBeNull();
    const next = await queryExpand(initial.continuation_token!, {
      cache,
      additionalTokens: 1024,
    });
    if ("error" in next) throw new Error(next.error);
    expect(next.tier).toBe(1);
    expect(next.content.length).toBeGreaterThan(0);
    expect(next.tokens_shipped_total).toBeGreaterThan(initial.tokens_shipped_total);
  });
});

describe("query_expand: invalid token", () => {
  it("returns an error for unknown continuation_token", async () => {
    const cache = new ProgressiveCache();
    const next = await queryExpand("00000000-0000-0000-0000-000000000000", {
      cache,
      additionalTokens: 512,
    });
    expect(next).toMatchObject({ error: expect.stringContaining("expired or invalid") });
  });
});

describe("query_expand: budget exhaustion", () => {
  it("returns an error when max_tokens_total is exceeded", async () => {
    // Force-insert a fresh entry where shipped already equals max so the
    // budget-exhausted branch fires deterministically regardless of how
    // many tokens the renderer happens to use for the natural-language
    // payload (which varies with the fixture content).
    const cache = new ProgressiveCache();
    const token = cache.put({
      question: "test",
      hits: [],
      lastTierServed: 0,
      tokensShippedSoFar: 1000,
      maxTokensTotal: 1000,
    });
    const next = await queryExpand(token, { cache, additionalTokens: 100 });
    expect(next).toMatchObject({ error: expect.stringContaining("exhausted") });
  });
});

describe("query_expand: malformed input rejection", () => {
  it("zero / negative additional tokens fall back to default", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const initial = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
    });
    const next = await queryExpand(initial.continuation_token!, {
      cache,
      additionalTokens: 0,
    });
    if ("error" in next) throw new Error(next.error);
    expect(next.tokens_delivered).toBeGreaterThan(0);
  });
});

describe("query_expand: token-budget enforcement", () => {
  it("payload never exceeds additional_tokens cap", async () => {
    const wiki = makeMiniWiki();
    await loadSmallCorpus(wiki);
    const cache = new ProgressiveCache();

    const initial = await queryProgressive("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      cache,
      maxTokensInitial: 100,
      maxTokensTotal: 16384,
    });
    const budget = 200;
    const next = await queryExpand(initial.continuation_token!, {
      cache,
      additionalTokens: budget,
    });
    if ("error" in next) throw new Error(next.error);
    expect(next.tokens_delivered).toBeLessThanOrEqual(budget);
    expect(next.content.length).toBeLessThanOrEqual(budget * CHARS_PER_TOKEN);
  });
});
