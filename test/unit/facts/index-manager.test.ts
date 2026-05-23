/**
 * Unit tests for src/facts/index-manager.ts.
 */
import { describe, expect, it } from "vitest";
import { FactIndex, QUESTION_WEIGHT, FACT_WEIGHT } from "../../../src/facts/index-manager.js";
import type { Fact, FactQuestion } from "../../../src/facts/types.js";

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

describe("FactIndex: rebuild + search", () => {
  it("matches via entity / statement on the facts engine", () => {
    const index = new FactIndex();
    index.rebuild([fact(1, "Photosynthesis", "Photosynthesis converts light into glucose.")], []);
    const hits = index.search("photosynthesis", 5);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.fact.id).toBe(1);
    expect(hits[0]!.matched_via_fact).toBe(true);
    expect(hits[0]!.matched_via_question).toBe(false);
  });

  it("matches via question text on the questions engine", () => {
    const index = new FactIndex();
    index.rebuild(
      [fact(1, "Photosynthesis", "It uses chloroplasts.")],
      [question(1, 1, "What process converts sunlight to energy?")],
    );
    const hits = index.search("sunlight energy", 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.fact.id).toBe(1);
    expect(hits[0]!.matched_via_question).toBe(true);
  });

  it("fuses scores with QUESTION_WEIGHT > FACT_WEIGHT", () => {
    expect(QUESTION_WEIGHT).toBeGreaterThan(FACT_WEIGHT);
    expect(QUESTION_WEIGHT + FACT_WEIGHT).toBe(1);
  });

  it("returns empty array when query is empty or index is empty", () => {
    const index = new FactIndex();
    expect(index.search("", 5)).toEqual([]);
    expect(index.search("anything", 5)).toEqual([]);
    index.rebuild([fact(1, "X", "Y")], []);
    expect(index.search("", 5)).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const index = new FactIndex();
    const facts = Array.from({ length: 10 }, (_, i) => fact(i + 1, `Topic${i}`, `Topic ${i} body`));
    index.rebuild(facts, []);
    const hits = index.search("topic", 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("FactIndex: add + remove", () => {
  it("add registers a fresh fact + its questions without full rebuild", () => {
    const index = new FactIndex();
    index.add(fact(1, "Photosynthesis", "It uses light."));
    expect(index.size()).toBe(1);
    index.add(fact(2, "Chlorophyll", "Pigment that absorbs light."), [
      question(10, 2, "What does chlorophyll do?"),
    ]);
    expect(index.size()).toBe(2);
    expect(index.questionCount()).toBe(1);
    expect(index.search("chlorophyll", 5)[0]!.fact.id).toBe(2);
  });

  it("remove drops a fact from the lookup map + index", () => {
    const index = new FactIndex();
    index.add(fact(1, "X", "X is X."));
    expect(index.size()).toBe(1);
    index.remove(1);
    expect(index.size()).toBe(0);
    expect(index.search("X", 5)).toEqual([]);
  });
});
