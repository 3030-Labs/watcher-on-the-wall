/**
 * Phase 3 — fact-level scorer tests. Proves semantic (not string-equality)
 * matching, correct precision/recall, and that the accepted-delta normalization
 * prevents characterized single-pass behavior from scoring as a miss.
 */
import { describe, it, expect } from "vitest";
import { scoreFacts, contentTokens } from "./score.js";
import { stripAcceptedDeltaArtifacts } from "./accepted-deltas.js";
import type { ExtractedFact, GoldFact } from "./types.js";

const gold: GoldFact[] = [
  { entity: "Tardigrades", statement: "first described in 1773 by Johann Goeze" },
  { entity: "Tardigrades", statement: "can survive the vacuum of outer space" },
  { entity: "Tardigrades", statement: "enter a dehydrated state called a tun" },
];

describe("scoreFacts — semantic matching, not string equality", () => {
  it("matches differently-worded statements about the same fact", () => {
    const extracted: ExtractedFact[] = [
      // Reworded, not verbatim — must still match.
      {
        entity: "Tardigrade",
        statement: "Goeze first described them in the year 1773",
        questions: [],
      },
      {
        entity: "Tardigrades",
        statement: "able to survive outer space vacuum exposure",
        questions: [],
      },
      { entity: "Tardigrades", statement: "can enter a dehydrated tun state", questions: [] },
    ];
    const s = scoreFacts(gold, extracted);
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.f1).toBe(1);
  });

  it("computes partial recall when a gold fact is missed", () => {
    const extracted: ExtractedFact[] = [
      { entity: "Tardigrades", statement: "described in 1773 by Goeze", questions: [] },
      { entity: "Tardigrades", statement: "survive the vacuum of space", questions: [] },
    ];
    const s = scoreFacts(gold, extracted);
    expect(s.matchedGold).toBe(2);
    expect(s.totalGold).toBe(3);
    expect(s.recall).toBeCloseTo(2 / 3, 5);
    expect(s.precision).toBe(1);
    expect(s.missedGold).toHaveLength(1);
  });

  it("penalizes precision when an extracted fact matches nothing (hallucination)", () => {
    const extracted: ExtractedFact[] = [
      { entity: "Tardigrades", statement: "described in 1773 by Goeze", questions: [] },
      {
        entity: "Tardigrades",
        statement: "they are a kind of reptile native to Mars",
        questions: [],
      },
    ];
    const s = scoreFacts(gold, extracted);
    expect(s.matchedExtracted).toBe(1);
    expect(s.precision).toBe(0.5);
  });

  it("does not let one extracted fact satisfy two gold facts (1:1 assignment)", () => {
    const twoGold: GoldFact[] = [
      { entity: "Python", statement: "created by Guido van Rossum" },
      { entity: "Python", statement: "first released in 1991" },
    ];
    const extracted: ExtractedFact[] = [
      {
        entity: "Python",
        statement: "created by Guido van Rossum and released 1991",
        questions: [],
      },
    ];
    const s = scoreFacts(twoGold, extracted);
    // One extracted fact can match at most one gold fact.
    expect(s.matchedGold).toBeLessThanOrEqual(1);
    expect(s.matchedExtracted).toBeLessThanOrEqual(1);
  });

  it("requires entity alignment — right claim about wrong entity is not a match", () => {
    const g: GoldFact[] = [{ entity: "Mitochondria", statement: "generate most of the cell ATP" }];
    const extracted: ExtractedFact[] = [
      { entity: "Ribosome", statement: "generate most of the cell ATP", questions: [] },
    ];
    const s = scoreFacts(g, extracted);
    expect(s.matchedGold).toBe(0);
  });
});

describe("accepted-delta normalization", () => {
  it("strips backlink paths so path-style drift never causes a miss", () => {
    expect(stripAcceptedDeltaArtifacts("see ./light-reactions.md here")).toContain(
      "light-reactions",
    );
    expect(stripAcceptedDeltaArtifacts("see ./light-reactions.md here")).not.toContain(".md");
    const g: GoldFact[] = [
      { entity: "Calvin cycle", statement: "linked to light-dependent-reactions" },
    ];
    const extracted: ExtractedFact[] = [
      // wiki-rooted path style vs relative style — accepted backlink-path drift.
      {
        entity: "Calvin cycle",
        statement: "linked to wiki/concepts/light-dependent-reactions.md",
        questions: [],
      },
    ];
    expect(scoreFacts(g, extracted).recall).toBe(1);
  });

  it("strips ISO timestamps so clock leakage is not counted as content", () => {
    expect(stripAcceptedDeltaArtifacts("compiled 2026-05-31T06:29:14.704Z done")).not.toMatch(
      /2026-05-31/,
    );
  });

  it("treats consolidated-entity aliases as the same entity (page-consolidation delta)", () => {
    const g: GoldFact[] = [
      {
        entity: "C4 plants",
        statement: "use a carbon fixation pathway distinct from C3",
        aliases: ["C3/C4/CAM plants", "photosynthetic pathways"],
      },
    ];
    const extracted: ExtractedFact[] = [
      // single-pass consolidated the page under a combined entity name.
      {
        entity: "C3/C4/CAM plants",
        statement: "use a distinct carbon fixation pathway from C3",
        questions: [],
      },
    ];
    expect(scoreFacts(g, extracted).recall).toBe(1);
  });
});

describe("contentTokens", () => {
  it("drops stopwords and punctuation", () => {
    const toks = contentTokens("The mitochondrion is the powerhouse of the cell.");
    expect(toks.has("mitochondrion")).toBe(true);
    expect(toks.has("powerhouse")).toBe(true);
    expect(toks.has("the")).toBe(false);
    expect(toks.has("of")).toBe(false);
  });
});
