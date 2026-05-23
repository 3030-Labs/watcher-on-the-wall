/**
 * Unit tests for define (Feature Pass 007).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineEntity } from "../../../src/server/narrow-query.js";
import { CHARS_PER_TOKEN } from "../../../src/server/token-estimator.js";
import { loadCanonicalFixtures, makeMiniWiki } from "./test-helpers.js";

describe("define: happy path", () => {
  it("returns the Definition section for the matched entity", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await defineEntity("Photosynthesis", {
      store: wiki.store,
      search: wiki.search,
    });
    expect(result.no_hits).toBe(false);
    expect(result.definition).toContain("process");
    expect(result.definition).toContain("plants");
    expect(result.source_page).toContain("photosynthesis.md");
    expect(result.score).toBeGreaterThan(0);
  });
});

describe("define: empty corpus", () => {
  it("returns no_hits=true with empty definition", async () => {
    const wiki = makeMiniWiki();

    const result = await defineEntity("anything", {
      store: wiki.store,
      search: wiki.search,
    });
    expect(result.no_hits).toBe(true);
    expect(result.definition).toBe("");
    expect(result.source_page).toBeNull();
  });
});

describe("define: token-budget enforcement", () => {
  it("definition length stays within the requested cap", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await defineEntity("Photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      maxTokens: 50,
    });
    expect(result.tokens).toBeLessThanOrEqual(50);
    expect(result.definition.length).toBeLessThanOrEqual(50 * CHARS_PER_TOKEN);
  });
});

describe("define: malformed input rejection", () => {
  it("zero / negative max_tokens falls back to default", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await defineEntity("Photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      maxTokens: 0,
    });
    expect(result.tokens).toBeGreaterThan(0);
  });
});

describe("define: BM25-only regression guard", () => {
  it("narrow-query.ts source contains no vector/embedding imports", () => {
    const src = readFileSync(
      join(__dirname, "..", "..", "..", "src", "server", "narrow-query.ts"),
      "utf8",
    );
    expect(src).not.toMatch(
      /import[^;]+(?:@xenova|sentence-transformers|chromadb|pinecone|weaviate|faiss|hnswlib)/i,
    );
    expect(src).not.toMatch(/cosineSimilarity\s*\(/);
    expect(src).not.toMatch(/\.embed\s*\(/);
  });
});
