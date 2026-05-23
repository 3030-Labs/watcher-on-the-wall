/**
 * `query_facts` MCP tool implementation (Feature Pass 008).
 *
 * Runs the fused BM25 query against the {@link FactIndex} — the index
 * scores facts on entity/statement match (weight 0.4) and on synthetic-
 * question match (weight 0.6), then returns the top-N facts ranked by
 * fused score. When the fact layer is disabled or empty, returns a
 * fallback marker so the caller can dispatch to page-level retrieval.
 *
 * BM25-only commitment: this module touches only `FactIndex`, which
 * wraps minisearch. No vector code paths.
 */
import type { FactIndex } from "../facts/index-manager.js";
import type { FactStore } from "../facts/store.js";
import type { Fact } from "../facts/types.js";
import { heuristicTokens } from "./token-estimator.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;

export interface QueryFactsOptions {
  factIndex: FactIndex | null;
  factStore: FactStore | null;
  limit?: number;
}

export interface QueryFactsHit {
  fact: Fact;
  score: number;
  matched_via_question: boolean;
  matched_via_fact: boolean;
}

export interface QueryFactsResult {
  question: string;
  hits: QueryFactsHit[];
  /**
   * When the fact layer is disabled or empty, this is the string
   * "page-level" — the caller should fall back to `query_progressive` or
   * `query`. Otherwise null.
   */
  fallback: "page-level" | null;
  /** Approximate token count of the rendered hits + metadata. */
  tokens: number;
  /** Total active facts in the index (cheap; 0 when layer disabled). */
  index_size: number;
}

/**
 * Run a BM25 fact lookup. Empty / disabled fact layer surfaces a
 * `fallback: "page-level"` marker so the client LLM can route the
 * follow-up call without round-tripping for an empty payload.
 */
export function queryFacts(question: string, opts: QueryFactsOptions): QueryFactsResult {
  const limit = clampLimit(opts.limit);
  const factIndex = opts.factIndex;
  if (!factIndex || factIndex.size() === 0) {
    return {
      question,
      hits: [],
      fallback: "page-level",
      tokens: 0,
      index_size: factIndex?.size() ?? 0,
    };
  }
  const fused = factIndex.search(question, limit);
  const hits: QueryFactsHit[] = fused.map((h) => ({
    fact: h.fact,
    score: Number(h.score.toFixed(4)),
    matched_via_fact: h.matched_via_fact,
    matched_via_question: h.matched_via_question,
  }));
  // Render-size estimate: include the statements so the client LLM can
  // judge "do I have what I need?" before round-tripping for full pages.
  const rendered = hits
    .map((h) => `- ${h.fact.entity}: ${h.fact.statement} _(${h.fact.wiki_page_id})_`)
    .join("\n");
  return {
    question,
    hits,
    fallback: null,
    tokens: heuristicTokens(rendered),
    index_size: factIndex.size(),
  };
}

function clampLimit(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value)));
}

/**
 * Convenience renderer for the MCP tool — produces a markdown bullet
 * list of the matched facts plus a JSON metadata blob. Identical to the
 * style used by `query_progressive`.
 */
export function renderFactsMarkdown(result: QueryFactsResult): string {
  if (result.fallback === "page-level") {
    return result.index_size === 0
      ? "_fact layer is empty or disabled — call `query_progressive` or `query` instead_"
      : "_no facts matched — call `query_progressive` for page-level retrieval_";
  }
  if (result.hits.length === 0) return "_no facts found_";
  return result.hits
    .map(
      (h) =>
        `- **${h.fact.entity}**: ${h.fact.statement} _(score ${h.score.toFixed(3)} · ${h.fact.wiki_page_id})_`,
    )
    .join("\n");
}
