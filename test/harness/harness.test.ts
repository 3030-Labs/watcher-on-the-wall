/**
 * Phase 3 — harness orchestration tests. Proves the end-to-end flow with an
 * injected ExtractFn: scoring, the INTENTIONAL-REGRESSION catch, new-baseline
 * reporting, and skip-on-no-extraction (never a false regression).
 */
import { describe, it, expect } from "vitest";
import { runHarness, type ExtractFn } from "./harness.js";
import type { BaselineStore, ExtractedFact, GoldFixture } from "./types.js";

const fixtures: GoldFixture[] = [
  {
    id: "f-photosynthesis",
    title: "Photosynthesis",
    format: "markdown",
    sourcePath: "/dev/null",
    goldFacts: [
      { entity: "Photosynthesis", statement: "converts light energy into chemical energy" },
      { entity: "Photosynthesis", statement: "occurs in the chloroplast" },
      { entity: "Chlorophyll", statement: "is the green pigment that absorbs light" },
    ],
  },
];

// A faithful extraction that should score high against the gold set.
const goodFacts: ExtractedFact[] = [
  {
    entity: "Photosynthesis",
    statement: "converts light energy to chemical energy",
    questions: [],
  },
  { entity: "Photosynthesis", statement: "takes place in chloroplasts", questions: [] },
  { entity: "Chlorophyll", statement: "green pigment that absorbs light", questions: [] },
];

// A degraded extraction — only one fact survives (the intentional regression).
const degradedFacts: ExtractedFact[] = [
  {
    entity: "Photosynthesis",
    statement: "converts light energy to chemical energy",
    questions: [],
  },
];

describe("runHarness", () => {
  it("scores a provider over fixtures and records new baselines when none exist", async () => {
    const extract: ExtractFn = async () => goodFacts;
    const report = await runHarness({
      providers: ["anthropic"],
      fixtures,
      baselines: {},
      extract,
    });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].status).toBe("scored");
    expect(report.rows[0].score!.recall).toBe(1);
    expect(report.regressions).toHaveLength(0);
    expect(report.newBaselines).toHaveLength(1);
  });

  it("CATCHES an intentional regression against a recorded baseline", async () => {
    // Baseline recorded from the good run (recall 1.0).
    const baselines: BaselineStore = {
      anthropic: {
        "f-photosynthesis": {
          precision: 1,
          recall: 1,
          model: "claude-sonnet-4-5",
          recordedAt: "x",
        },
      },
    };
    const extract: ExtractFn = async () => degradedFacts; // 1/3 recall
    const report = await runHarness({ providers: ["anthropic"], fixtures, baselines, extract });
    expect(report.regressions).toHaveLength(1);
    expect(report.regressions[0].fixtureId).toBe("f-photosynthesis");
    expect(report.regressions[0].reason).toMatch(/recall/);
  });

  it("does NOT flag the accepted-delta variant as a regression", async () => {
    const baselines: BaselineStore = {
      anthropic: {
        "f-photosynthesis": {
          precision: 1,
          recall: 1,
          model: "claude-sonnet-4-5",
          recordedAt: "x",
        },
      },
    };
    // Same facts but with backlink-path-style drift + reworded — accepted delta.
    const deltaFacts: ExtractedFact[] = [
      {
        entity: "Photosynthesis",
        statement: "converts light energy into chemical energy",
        questions: [],
      },
      {
        entity: "Photosynthesis",
        statement: "occurs in wiki/concepts/chloroplast.md",
        questions: [],
      },
      { entity: "Chlorophyll", statement: "the green pigment absorbing light", questions: [] },
    ];
    const extract: ExtractFn = async () => deltaFacts;
    const report = await runHarness({ providers: ["anthropic"], fixtures, baselines, extract });
    expect(report.regressions).toHaveLength(0);
  });

  it("skips (provider, fixture) with no extraction available — never a regression", async () => {
    const extract: ExtractFn = async (provider) => (provider === "openai" ? null : goodFacts);
    const report = await runHarness({
      providers: ["anthropic", "openai"],
      fixtures,
      baselines: {},
      extract,
    });
    expect(report.skipped).toEqual([{ provider: "openai", fixtureId: "f-photosynthesis" }]);
    expect(report.regressions).toHaveLength(0);
    const openaiRow = report.rows.find((r) => r.provider === "openai")!;
    expect(openaiRow.status).toBe("skipped");
  });
});
