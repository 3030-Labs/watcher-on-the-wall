/**
 * Harness orchestrator — Phase 3.
 *
 * Runs each provider over each gold fixture, scores fact-level precision/recall,
 * and checks regression-from-baseline. The EXTRACTION step is injected
 * (`ExtractFn`) so the orchestration logic is deterministic and unit-testable
 * without a live model:
 *   - CI / replay mode injects a cassette-backed ExtractFn (offline, free).
 *   - The live baseline runner injects a real-extractor ExtractFn.
 *
 * An ExtractFn returning `null` means "no extraction available for this
 * (provider, fixture)" (e.g. a non-Anthropic provider with no key and no
 * cassette) — reported as SKIPPED, never as a regression.
 */
import type {
  BaselineStore,
  ExtractedFact,
  GoldFixture,
  RegressionResult,
  ScoreResult,
} from "./types.js";
import { scoreFacts, type ScoreOptions } from "./score.js";
import { checkRegression, type CheckOptions } from "./regression.js";

export type ExtractFn = (provider: string, fixture: GoldFixture) => Promise<ExtractedFact[] | null>;

export interface HarnessRow {
  provider: string;
  fixtureId: string;
  status: "scored" | "skipped";
  score: ScoreResult | null;
  regression: RegressionResult | null;
}

export interface HarnessReport {
  rows: HarnessRow[];
  /** Rows that regressed (regression.regressed === true). */
  regressions: RegressionResult[];
  /** (provider, fixtureId) pairs with a score but no prior baseline. */
  newBaselines: { provider: string; fixtureId: string; score: ScoreResult }[];
  /** (provider, fixtureId) pairs with no extraction available. */
  skipped: { provider: string; fixtureId: string }[];
}

export interface RunHarnessOptions {
  providers: string[];
  fixtures: GoldFixture[];
  baselines: BaselineStore;
  extract: ExtractFn;
  score?: ScoreOptions;
  check?: CheckOptions;
}

export async function runHarness(opts: RunHarnessOptions): Promise<HarnessReport> {
  const rows: HarnessRow[] = [];
  const regressions: RegressionResult[] = [];
  const newBaselines: HarnessReport["newBaselines"] = [];
  const skipped: HarnessReport["skipped"] = [];

  for (const provider of opts.providers) {
    for (const fixture of opts.fixtures) {
      const extracted = await opts.extract(provider, fixture);
      if (extracted === null) {
        rows.push({
          provider,
          fixtureId: fixture.id,
          status: "skipped",
          score: null,
          regression: null,
        });
        skipped.push({ provider, fixtureId: fixture.id });
        continue;
      }
      const score = scoreFacts(fixture.goldFacts, extracted, opts.score);
      const regression = checkRegression(provider, fixture.id, score, opts.baselines, opts.check);
      rows.push({ provider, fixtureId: fixture.id, status: "scored", score, regression });
      if (regression.regressed) regressions.push(regression);
      if (regression.baseline === null)
        newBaselines.push({ provider, fixtureId: fixture.id, score });
    }
  }

  return { rows, regressions, newBaselines, skipped };
}
