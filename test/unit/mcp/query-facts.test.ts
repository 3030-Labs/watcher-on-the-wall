/**
 * Unit tests for query_facts (Feature Pass 008).
 */
import { describe, expect, it } from "vitest";
import { FactIndex } from "../../../src/facts/index-manager.js";
import type { Fact, FactQuestion } from "../../../src/facts/types.js";
import { queryFacts, renderFactsMarkdown } from "../../../src/server/fact-query.js";

function fact(id: number, entity: string, statement: string): Fact {
  return {
    id,
    wiki_page_id: `wiki/concepts/${entity.toLowerCase()}.md`,
    entity,
    statement,
    fact_hash: `hash-${id}`,
    created_at: "2026-05-23T12:00:00.000Z",
    superseded_at: null,
  };
}

function question(id: number, factId: number, text: string): FactQuestion {
  return {
    id,
    fact_id: factId,
    question_text: text,
    question_hash: `qhash-${id}`,
  };
}

describe("query_facts: happy path", () => {
  it("returns ranked facts with score + match metadata", () => {
    const idx = new FactIndex();
    idx.rebuild(
      [
        fact(1, "Photosynthesis", "Photosynthesis converts light into glucose."),
        fact(2, "Mitochondria", "Mitochondria generate ATP."),
      ],
      [
        question(1, 1, "What does photosynthesis produce?"),
        question(2, 2, "What do mitochondria produce?"),
      ],
    );
    const result = queryFacts("photosynthesis glucose", {
      factIndex: idx,
      factStore: null,
    });
    expect(result.fallback).toBeNull();
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits[0]!.fact.entity).toBe("Photosynthesis");
    expect(result.tokens).toBeGreaterThan(0);
    expect(result.index_size).toBe(2);
  });
});

describe("query_facts: empty / disabled fact layer", () => {
  it("returns fallback:page-level when factIndex is null", () => {
    const result = queryFacts("anything", { factIndex: null, factStore: null });
    expect(result.fallback).toBe("page-level");
    expect(result.hits).toEqual([]);
    expect(result.index_size).toBe(0);
  });
  it("returns fallback:page-level when factIndex is empty", () => {
    const idx = new FactIndex();
    const result = queryFacts("anything", { factIndex: idx, factStore: null });
    expect(result.fallback).toBe("page-level");
  });
});

describe("query_facts: limit clamping", () => {
  it("clamps limit to [1, 20]", () => {
    const idx = new FactIndex();
    idx.rebuild(
      Array.from({ length: 30 }, (_, i) =>
        fact(i + 1, `Topic${i}`, `topic ${i} description with keyword common`),
      ),
      [],
    );
    expect(
      queryFacts("common", { factIndex: idx, factStore: null, limit: 0 }).hits.length,
    ).toBeLessThanOrEqual(5);
    expect(
      queryFacts("common", { factIndex: idx, factStore: null, limit: 100 }).hits.length,
    ).toBeLessThanOrEqual(20);
    expect(
      queryFacts("common", { factIndex: idx, factStore: null, limit: 3 }).hits.length,
    ).toBeLessThanOrEqual(3);
  });
});

describe("query_facts: malformed input", () => {
  it("rejects empty question (no hits, fallback)", () => {
    const idx = new FactIndex();
    idx.rebuild([fact(1, "X", "y")], []);
    const result = queryFacts("", { factIndex: idx, factStore: null });
    expect(result.hits).toEqual([]);
  });
});

describe("query_facts: rendered markdown", () => {
  it("renders a fallback hint when the layer is disabled / empty", () => {
    const r1 = queryFacts("x", { factIndex: null, factStore: null });
    expect(renderFactsMarkdown(r1)).toContain("disabled");
  });
  it("renders 'no facts found' when the layer is populated but no match", () => {
    const idx = new FactIndex();
    idx.rebuild([fact(1, "Photosynthesis", "Plants do photosynthesis.")], []);
    const r2 = queryFacts("zzz-unknown-token", { factIndex: idx, factStore: null });
    expect(renderFactsMarkdown(r2)).toContain("no facts");
  });
});
