/**
 * Unit tests for cite_sources (Feature Pass 007).
 */
import { describe, expect, it } from "vitest";
import { citeSources } from "../../../src/server/narrow-query.js";
import { CHARS_PER_TOKEN } from "../../../src/server/token-estimator.js";
import type { ProvenanceChain } from "../../../src/provenance/chain.js";
import type { ProvenanceRecord } from "../../../src/utils/types.js";
import { loadCanonicalFixtures, makeMiniWiki } from "./test-helpers.js";

function makeFakeChain(records: ProvenanceRecord[]): ProvenanceChain {
  // We only need recordsFor for this test. Cast to ProvenanceChain to keep
  // the call-site type-clean without building the full mutex / hmac state.
  return {
    async recordsFor(pathArg: string): Promise<ProvenanceRecord[]> {
      return records.filter(
        (r) => r.wiki_files_written.includes(pathArg) || r.source_files.includes(pathArg),
      );
    },
  } as unknown as ProvenanceChain;
}

function makeRecord(overrides: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    id: "rec-id",
    seq: 1,
    timestamp: "2026-05-22T12:00:00.000Z",
    type: "ingest",
    source_files: ["raw/biology.txt"],
    source_hashes: ["sha256-deadbeef"],
    prompt_hash: "sha256-prompt",
    model_id: "claude-haiku-4-5",
    response_hash: "sha256-response",
    wiki_files_written: ["wiki/concepts/photosynthesis.md"],
    wiki_file_hashes_after: { "wiki/concepts/photosynthesis.md": "sha256-page" },
    previous_id: null,
    previous_chain_hash: "0".repeat(64),
    chain_hash: "1".repeat(64),
    ...overrides,
  };
}

describe("cite_sources: happy path", () => {
  it("returns citations for pages with provenance records", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const chain = makeFakeChain([makeRecord({})]);

    const result = await citeSources("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      provenance: chain,
    });
    expect(result.no_hits).toBe(false);
    expect(result.provenance_unavailable).toBe(false);
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.source_files).toContain("raw/biology.txt");
    expect(result.citations[0]!.chain_hash).toHaveLength(16);
  });
});

describe("cite_sources: provenance disabled", () => {
  it("returns provenance_unavailable=true when chain is null", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);

    const result = await citeSources("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      provenance: null,
    });
    expect(result.provenance_unavailable).toBe(true);
    expect(result.citations).toHaveLength(0);
  });
});

describe("cite_sources: empty corpus", () => {
  it("returns no_hits=true for an empty wiki", async () => {
    const wiki = makeMiniWiki();
    const chain = makeFakeChain([]);

    const result = await citeSources("anything", {
      store: wiki.store,
      search: wiki.search,
      provenance: chain,
    });
    expect(result.no_hits).toBe(true);
    expect(result.citations).toHaveLength(0);
  });
});

describe("cite_sources: token-budget enforcement", () => {
  it("aggregate citation size respects max_tokens cap", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const chain = makeFakeChain([
      makeRecord({}),
      makeRecord({
        wiki_files_written: ["wiki/concepts/rust-borrow-checker.md"],
      }),
    ]);

    const cap = 32;
    const result = await citeSources("rust borrow checker", {
      store: wiki.store,
      search: wiki.search,
      provenance: chain,
      maxTokens: cap,
    });
    expect(result.tokens).toBeLessThanOrEqual(cap);
    const serialized = JSON.stringify(result.citations);
    expect(serialized.length).toBeLessThanOrEqual(cap * CHARS_PER_TOKEN);
  });
});

describe("cite_sources: malformed input rejection", () => {
  it("zero max_tokens falls back to default", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const chain = makeFakeChain([makeRecord({})]);

    const result = await citeSources("photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      provenance: chain,
      maxTokens: 0,
    });
    expect(result.tokens).toBeGreaterThan(0);
  });
});
