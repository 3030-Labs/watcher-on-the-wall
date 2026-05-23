/**
 * Unit tests for estimate_query_cost (Feature Pass 006).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { estimateQueryCost } from "../../../src/server/cost-estimator.js";
import { loadCanonicalFixtures, makeMiniWiki } from "./test-helpers.js";

describe("estimate_query_cost: happy path", () => {
  it("returns a positive token count for a real question", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await estimateQueryCost("what is photosynthesis?", {
      store: wiki.store,
      search: wiki.search,
      config: wiki.config,
    });
    // Configured llm.provider defaults to "anthropic" in defaultConfig,
    // so the single-provider path is exercised.
    expect(result.estimates.length).toBeGreaterThanOrEqual(1);
    expect(result.estimates[0]!.tokens).toBeGreaterThan(0);
    expect(result.hit_count).toBeGreaterThan(0);
    expect(result.retrieval_payload_chars).toBeGreaterThan(0);
  });
});

describe("estimate_query_cost: empty corpus", () => {
  it("returns no_hits with zero tokens", async () => {
    const wiki = makeMiniWiki();

    const result = await estimateQueryCost("anything", {
      store: wiki.store,
      search: wiki.search,
      config: wiki.config,
    });
    expect(result.no_hits).toBe(true);
    expect(result.retrieval_payload_chars).toBe(0);
  });
});

describe("estimate_query_cost: provider expansion", () => {
  it("returns 4 rows when no provider is specified and no env override", async () => {
    delete process.env.WOTW_LLM_PROVIDER;
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    // Erase the daemon's configured provider so the "all providers"
    // branch is exercised.
    wiki.config.llm.provider = undefined as never;

    const result = await estimateQueryCost("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      config: wiki.config,
    });
    expect(result.estimates).toHaveLength(4);
    const providers = result.estimates.map((e) => e.provider).sort();
    expect(providers).toEqual(["anthropic", "gemini", "ollama", "openai"]);
  });
  it("returns a single row when provider is explicitly set", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await estimateQueryCost("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      config: wiki.config,
      provider: "openai",
    });
    expect(result.estimates).toHaveLength(1);
    expect(result.estimates[0]!.provider).toBe("openai");
  });
});

describe("estimate_query_cost: malformed input", () => {
  it("treats negative / zero k as the default", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await estimateQueryCost("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      config: wiki.config,
      k: 0,
    });
    expect(result.hit_count).toBeGreaterThan(0);
  });
});

describe("estimate_query_cost: BM25-only regression guard", () => {
  it("cost-estimator.ts source contains no vector/embedding imports", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "server", "cost-estimator.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /import[^;]+(?:@xenova|sentence-transformers|chromadb|pinecone|weaviate|faiss|hnswlib)/i,
    );
    expect(src).not.toMatch(/cosineSimilarity\s*\(/);
    expect(src).not.toMatch(/\.embed\s*\(/);
  });
});
