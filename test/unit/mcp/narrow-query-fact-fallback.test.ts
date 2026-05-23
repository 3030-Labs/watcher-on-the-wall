/**
 * Verify the Pass A narrow-query tools (define / relate / cite_sources)
 * check the Pass B fact layer first when it's populated, and fall back
 * to page-level retrieval when the layer is empty / disabled / sparse.
 */
import { describe, expect, it } from "vitest";
import { FactIndex } from "../../../src/facts/index-manager.js";
import type { Fact, FactQuestion } from "../../../src/facts/types.js";
import { citeSources, defineEntity, relateEntities } from "../../../src/server/narrow-query.js";
import { loadCanonicalFixtures, makeMiniWiki } from "./test-helpers.js";

function fact(id: number, page: string, entity: string, statement: string): Fact {
  return {
    id,
    wiki_page_id: page,
    entity,
    statement,
    fact_hash: `h${id}`,
    created_at: "2026-05-23T12:00:00.000Z",
    superseded_at: null,
  };
}

function question(id: number, factId: number, text: string): FactQuestion {
  return { id, fact_id: factId, question_text: text, question_hash: `q${id}` };
}

describe("defineEntity: prefers fact layer when populated", () => {
  it("returns source_layer:'fact' when a fact matches", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = new FactIndex();
    idx.rebuild(
      [
        fact(
          1,
          "wiki/concepts/photosynthesis.md",
          "Photosynthesis",
          "Photosynthesis converts light energy into chemical energy.",
        ),
      ],
      [question(1, 1, "What is photosynthesis?")],
    );
    const result = await defineEntity("Photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      factIndex: idx,
    });
    expect(result.source_layer).toBe("fact");
    expect(result.definition).toContain("light energy");
    expect(result.source_page).toBe("wiki/concepts/photosynthesis.md");
  });

  it("falls back to page layer when fact index is empty", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = new FactIndex();
    const result = await defineEntity("Photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      factIndex: idx,
    });
    expect(result.source_layer).toBe("page");
    expect(result.no_hits).toBe(false);
  });
});

describe("relateEntities: prefers fact layer when both anchors mentioned", () => {
  it("returns source_layer:'fact' when a fact mentions both anchors", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = new FactIndex();
    idx.rebuild(
      [
        fact(
          1,
          "wiki/concepts/photosynthesis.md",
          "Photosynthesis chlorophyll",
          "Photosynthesis uses chlorophyll to capture light.",
        ),
      ],
      [],
    );
    const result = await relateEntities("Photosynthesis", "chlorophyll", {
      store: wiki.store,
      search: wiki.search,
      factIndex: idx,
    });
    expect(result.source_layer).toBe("fact");
    expect(result.statements.length).toBeGreaterThan(0);
  });
});

describe("citeSources: uses fact layer to pick pages, then provenance per page", () => {
  it("source_layer:'fact' when a fact matches the claim", async () => {
    const wiki = makeMiniWiki();
    await loadCanonicalFixtures(wiki);
    const idx = new FactIndex();
    idx.rebuild(
      [
        fact(
          1,
          "wiki/concepts/photosynthesis.md",
          "Photosynthesis",
          "Photosynthesis produces oxygen.",
        ),
      ],
      [],
    );
    // Build a fake chain that mentions the page so cite_sources has
    // something to cite. We pass a minimal chain object with recordsFor.
    const fakeChain = {
      async recordsFor(p: string) {
        if (p === "wiki/concepts/photosynthesis.md") {
          return [
            {
              id: "rec",
              seq: 1,
              timestamp: "2026-05-23T12:00:00.000Z",
              type: "ingest",
              source_files: ["raw/biology.txt"],
              source_hashes: ["sha"],
              prompt_hash: "p",
              model_id: "m",
              response_hash: "r",
              wiki_files_written: [p],
              wiki_file_hashes_after: {},
              previous_id: null,
              previous_chain_hash: "0".repeat(64),
              chain_hash: "1".repeat(64),
            },
          ];
        }
        return [];
      },
    } as never;
    const result = await citeSources("oxygen photosynthesis", {
      store: wiki.store,
      search: wiki.search,
      provenance: fakeChain,
      factIndex: idx,
    });
    expect(result.source_layer).toBe("fact");
    expect(result.citations.length).toBeGreaterThan(0);
    expect(result.citations[0]!.wiki_page).toBe("wiki/concepts/photosynthesis.md");
  });
});
