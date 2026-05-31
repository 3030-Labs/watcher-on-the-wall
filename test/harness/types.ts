/**
 * Multi-LLM verify-and-harness arc — Phase 3 gold-fact regression harness types.
 *
 * The harness scores a provider's extracted facts against a per-fixture
 * gold-standard fact set using FACT-LEVEL precision/recall (never string
 * equality — extraction is stochastic and cross-provider output never matches
 * verbatim), then gates on REGRESSION-FROM-BASELINE rather than absolute bars.
 *
 * Lives under test/ (not src/) by repo convention: it is QA infrastructure, not
 * shipped daemon runtime. It consumes the SHIPPED `ExtractedFact` shape so the
 * thing under test is the real extractor output.
 */
import type { ExtractedFact } from "../../src/facts/extractor.js";

/** A single canonical fact in a fixture's gold set. */
export interface GoldFact {
  /** Canonical entity the fact is about (e.g., "Tardigrades"). */
  entity: string;
  /** The atomic claim (e.g., "first described in 1773 by Goeze"). */
  statement: string;
  /**
   * Optional alternate entity spellings/granularities that should count as the
   * same entity (supports the page-consolidation accepted delta).
   */
  aliases?: string[];
}

/** A fixture: a source document + its gold-standard fact set. */
export interface GoldFixture {
  id: string;
  /** Short human title. */
  title: string;
  /** Source format — markdown prose, source code, or PDF-extracted text. */
  format: "markdown" | "code" | "pdf-text";
  /** Path to the source file, relative to the gold fixtures dir. */
  sourcePath: string;
  /** The gold fact set. */
  goldFacts: GoldFact[];
}

/** Result of scoring one provider's extraction against a fixture's gold set. */
export interface ScoreResult {
  /** matched gold facts / total gold facts. */
  recall: number;
  /** matched extracted facts / total extracted facts. */
  precision: number;
  /** Harmonic mean of precision and recall (0 when both 0). */
  f1: number;
  matchedGold: number;
  totalGold: number;
  matchedExtracted: number;
  totalExtracted: number;
  /** Gold facts that no extracted fact matched (the misses). */
  missedGold: GoldFact[];
}

/** Per-provider, per-fixture recorded baseline (precision + recall). */
export interface FixtureBaseline {
  precision: number;
  recall: number;
  /** Model used when the baseline was recorded. */
  model: string;
  recordedAt: string;
}

/** baselines.json shape: provider -> fixtureId -> baseline. */
export type BaselineStore = Record<string, Record<string, FixtureBaseline>>;

/** Outcome of comparing a current score against a recorded baseline. */
export interface RegressionResult {
  provider: string;
  fixtureId: string;
  regressed: boolean;
  /** Reason string when regressed; null otherwise. */
  reason: string | null;
  current: { precision: number; recall: number };
  baseline: { precision: number; recall: number } | null;
}

/** A recorded provider response for deterministic replay (feeds P4 CI). */
export interface Cassette {
  provider: string;
  fixtureId: string;
  model: string;
  /** The extractor output captured at record time. */
  facts: ExtractedFact[];
  recordedAt: string;
}

export type { ExtractedFact };
