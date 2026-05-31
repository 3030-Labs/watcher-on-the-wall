/**
 * Phase 3 — regression-from-baseline tests. Proves the gate fires on a real
 * drop, tolerates within-margin noise, and treats a missing baseline as a new
 * baseline (never a first-sight failure).
 */
import { describe, it, expect } from "vitest";
import { checkRegression, baselineFromScore, DEFAULT_MARGIN } from "./regression.js";
import type { BaselineStore, ScoreResult } from "./types.js";

function score(precision: number, recall: number): ScoreResult {
  return {
    precision,
    recall,
    f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
    matchedGold: 0,
    totalGold: 0,
    matchedExtracted: 0,
    totalExtracted: 0,
    missedGold: [],
  };
}

const baselines: BaselineStore = {
  anthropic: {
    "f1-tardigrades": { precision: 0.9, recall: 0.85, model: "claude-sonnet-4-5", recordedAt: "x" },
  },
};

describe("checkRegression", () => {
  it("no baseline -> not a regression (new baseline to record)", () => {
    const r = checkRegression("anthropic", "brand-new", score(0.1, 0.1), baselines);
    expect(r.regressed).toBe(false);
    expect(r.baseline).toBeNull();
  });

  it("flags a recall drop beyond the margin", () => {
    // recall 0.85 -> 0.70 is a 0.15 drop > default margin 0.1
    const r = checkRegression("anthropic", "f1-tardigrades", score(0.9, 0.7), baselines);
    expect(r.regressed).toBe(true);
    expect(r.reason).toMatch(/recall/);
  });

  it("flags a precision drop beyond the margin", () => {
    const r = checkRegression("anthropic", "f1-tardigrades", score(0.7, 0.85), baselines);
    expect(r.regressed).toBe(true);
    expect(r.reason).toMatch(/precision/);
  });

  it("tolerates a within-margin dip (stochastic noise is not a regression)", () => {
    // both drop exactly 0.05 < margin 0.1
    const r = checkRegression("anthropic", "f1-tardigrades", score(0.85, 0.8), baselines);
    expect(r.regressed).toBe(false);
  });

  it("an improvement is never a regression", () => {
    const r = checkRegression("anthropic", "f1-tardigrades", score(1, 1), baselines);
    expect(r.regressed).toBe(false);
  });

  it("respects a custom margin", () => {
    const r = checkRegression("anthropic", "f1-tardigrades", score(0.9, 0.8), baselines, {
      margin: 0.02,
    });
    // recall drop 0.05 > 0.02 -> regression under the tighter margin
    expect(r.regressed).toBe(true);
  });

  it("baselineFromScore captures precision/recall + provenance", () => {
    const b = baselineFromScore(score(0.8, 0.75), "claude-sonnet-4-5", "2026-05-31");
    expect(b).toEqual({
      precision: 0.8,
      recall: 0.75,
      model: "claude-sonnet-4-5",
      recordedAt: "2026-05-31",
    });
  });

  it("default margin is 0.1", () => {
    expect(DEFAULT_MARGIN).toBe(0.1);
  });
});
