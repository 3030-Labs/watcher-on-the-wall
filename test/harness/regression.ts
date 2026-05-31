/**
 * Regression-from-baseline gate — Phase 3.
 *
 * MATCH SEMANTICS (locked by the arc directive): gate on regression-from-
 * baseline, NOT absolute precision/recall bars. Each provider's baseline is set
 * on its first green run; a fixture regresses if precision OR recall drops below
 * that provider's recorded baseline by more than a fixed margin.
 *
 * A fixture with no recorded baseline is NOT a regression — it is a new baseline
 * to record (reported separately, never a CI failure on first sight).
 */
import type { BaselineStore, FixtureBaseline, RegressionResult, ScoreResult } from "./types.js";

/** Default tolerance: a drop strictly greater than this margin is a regression. */
export const DEFAULT_MARGIN = 0.1;

export interface CheckOptions {
  margin?: number;
}

/** Compare one current score against the recorded baseline for (provider, fixture). */
export function checkRegression(
  provider: string,
  fixtureId: string,
  current: ScoreResult,
  baselines: BaselineStore,
  opts: CheckOptions = {},
): RegressionResult {
  const margin = opts.margin ?? DEFAULT_MARGIN;
  const base: FixtureBaseline | undefined = baselines[provider]?.[fixtureId];

  if (!base) {
    return {
      provider,
      fixtureId,
      regressed: false,
      reason: null,
      current: { precision: current.precision, recall: current.recall },
      baseline: null,
    };
  }

  const precisionDrop = base.precision - current.precision;
  const recallDrop = base.recall - current.recall;
  const reasons: string[] = [];
  if (precisionDrop > margin) {
    reasons.push(
      `precision ${current.precision.toFixed(3)} < baseline ${base.precision.toFixed(3)} - ${margin}`,
    );
  }
  if (recallDrop > margin) {
    reasons.push(
      `recall ${current.recall.toFixed(3)} < baseline ${base.recall.toFixed(3)} - ${margin}`,
    );
  }

  return {
    provider,
    fixtureId,
    regressed: reasons.length > 0,
    reason: reasons.length > 0 ? reasons.join("; ") : null,
    current: { precision: current.precision, recall: current.recall },
    baseline: { precision: base.precision, recall: base.recall },
  };
}

/** Build/refresh a baseline entry from a score (used when recording baselines). */
export function baselineFromScore(
  score: ScoreResult,
  model: string,
  recordedAt: string,
): FixtureBaseline {
  return { precision: score.precision, recall: score.recall, model, recordedAt };
}
