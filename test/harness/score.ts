/**
 * Fact-level precision/recall scorer — Phase 3.
 *
 * Deterministic SEMANTIC matching (not string equality): a gold fact is matched
 * by an extracted fact when their entities align (alias-aware) AND their
 * statement content tokens overlap above a threshold. Greedy 1:1 assignment so
 * one extracted fact cannot satisfy two gold facts.
 *
 * Determinism matters: this scorer runs in CI against recorded cassettes
 * (Phase 4), so it must not depend on an LLM judge, wall-clock, or RNG.
 */
import type { ExtractedFact, GoldFact, ScoreResult } from "./types.js";
import { stripAcceptedDeltaArtifacts, STOPWORDS } from "./accepted-deltas.js";

/** Default statement content-overlap threshold (Jaccard). Tunable per call. */
export const DEFAULT_STATEMENT_THRESHOLD = 0.2;

function normalize(text: string): string {
  return stripAcceptedDeltaArtifacts(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Conservative stemmer — folds common plural/tense variants so "chloroplast"
 * and "chloroplasts", "absorb" and "absorbs", "release" and "released" match.
 * Deliberately light: it only needs to cut false misses from morphology, not be
 * linguistically complete.
 */
export function stem(token: string): string {
  let t = token;
  if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
  else if (t.length > 5 && t.endsWith("ed")) t = t.slice(0, -2);
  if (t.length > 4) {
    if (t.endsWith("ies")) t = t.slice(0, -3) + "y";
    else if (/(?:s|x|z|ch|sh)es$/.test(t)) t = t.slice(0, -2);
    else if (t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
  }
  return t;
}

/** Content tokens (normalized, stopwords removed, stemmed). */
export function contentTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of normalize(text).split(" ")) {
    if (tok.length === 0) continue;
    if (STOPWORDS.has(tok)) continue;
    out.add(stem(tok));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Alias-aware, normalized entity key. */
function entityForms(entity: string, aliases: string[] = []): Set<string> {
  const forms = new Set<string>();
  for (const e of [entity, ...aliases]) forms.add(normalize(e));
  return forms;
}

/** A token is "distinctive" if it carries a digit (a code like 404, 8849) or is
 * a long content word — distinctive tokens are strong entity signals. */
function isDistinctive(token: string): boolean {
  return /\d/.test(token) || token.length >= 5;
}

function distinctiveOf(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter(isDistinctive));
}

/**
 * Entity COMPATIBILITY — the extracted fact concerns the gold fact's entity.
 * Handles real-world variance: the extractor often labels facts more granularly
 * ("TCP SYN packet") while grounding the entity in the statement ("...the TCP
 * handshake..."), or uses a different label for the same subject. Two rules:
 *
 *   1. Positive grounding: normalized equality, substring (>=3 chars), entity
 *      token overlap, OR a distinctive gold-entity token (a code, or a long word
 *      like "handshake") appearing ANYWHERE in the extracted entity+statement.
 *   2. Conflict rejection: when BOTH entities carry distinctive tokens and
 *      neither is grounded in the other's text, they are different subjects
 *      (Mitochondria vs Ribosome) — not a match.
 *
 * Absent a conflict and absent positive grounding (e.g. both generic short
 * entities), compatibility is permissive — the statement-overlap threshold is
 * the primary gate.
 */
function entityCompatible(gold: GoldFact, ex: ExtractedFact): boolean {
  const gForms = entityForms(gold.entity, gold.aliases);
  const eNorm = normalize(ex.entity);
  const exEntityTokens = contentTokens(ex.entity);
  const exText = new Set([...exEntityTokens, ...contentTokens(ex.statement)]);

  const gEntityTokens = new Set<string>();
  for (const g of gForms) for (const t of contentTokens(g)) gEntityTokens.add(t);
  const gDistinct = distinctiveOf(gEntityTokens);

  // 1. positive grounding
  for (const g of gForms) {
    if (g === eNorm) return true;
    if (g.length >= 3 && eNorm.length >= 3 && (g.includes(eNorm) || eNorm.includes(g))) return true;
    if (jaccard(contentTokens(g), exEntityTokens) >= 0.34) return true;
  }
  for (const t of gDistinct) if (exText.has(t)) return true;

  // 2. conflict rejection — two distinct named subjects, neither grounded.
  const exDistinct = distinctiveOf(exEntityTokens);
  if (gDistinct.size > 0 && exDistinct.size > 0) {
    const goldText = new Set([...gEntityTokens, ...contentTokens(gold.statement)]);
    let exGroundedInGold = false;
    for (const t of exDistinct) if (goldText.has(t)) exGroundedInGold = true;
    if (!exGroundedInGold) return false;
  }

  // 3. no conflict — defer to the statement-overlap gate.
  return true;
}

export interface ScoreOptions {
  /** Statement content-overlap threshold for a match. */
  statementThreshold?: number;
  /**
   * If true, entity alignment is also required for a match. Default true.
   * (A statement about the wrong entity is not the same fact.)
   */
  requireEntity?: boolean;
}

/**
 * Score extracted facts against a gold set. Greedy best-overlap assignment.
 */
export function scoreFacts(
  goldFacts: GoldFact[],
  extracted: ExtractedFact[],
  opts: ScoreOptions = {},
): ScoreResult {
  const threshold = opts.statementThreshold ?? DEFAULT_STATEMENT_THRESHOLD;
  const requireEntity = opts.requireEntity ?? true;

  const goldTokens = goldFacts.map((g) => contentTokens(g.statement));
  const exTokens = extracted.map((e) => contentTokens(e.statement));
  const usedExtracted = new Set<number>();
  const matchedGoldIdx = new Set<number>();

  for (let gi = 0; gi < goldFacts.length; gi++) {
    let bestEx = -1;
    let bestOverlap = threshold; // must meet/exceed threshold to count
    for (let ei = 0; ei < extracted.length; ei++) {
      if (usedExtracted.has(ei)) continue;
      if (requireEntity && !entityCompatible(goldFacts[gi], extracted[ei])) continue;
      const overlap = jaccard(goldTokens[gi], exTokens[ei]);
      if (overlap >= bestOverlap) {
        bestOverlap = overlap;
        bestEx = ei;
      }
    }
    if (bestEx >= 0) {
      usedExtracted.add(bestEx);
      matchedGoldIdx.add(gi);
    }
  }

  const matchedGold = matchedGoldIdx.size;
  const matchedExtracted = usedExtracted.size;
  const totalGold = goldFacts.length;
  const totalExtracted = extracted.length;
  const recall = totalGold === 0 ? 1 : matchedGold / totalGold;
  const precision =
    totalExtracted === 0 ? (totalGold === 0 ? 1 : 0) : matchedExtracted / totalExtracted;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

  return {
    recall,
    precision,
    f1,
    matchedGold,
    totalGold,
    matchedExtracted,
    totalExtracted,
    missedGold: goldFacts.filter((_, i) => !matchedGoldIdx.has(i)),
  };
}
