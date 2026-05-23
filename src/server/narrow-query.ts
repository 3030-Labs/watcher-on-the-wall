/**
 * Structural narrow-query tools (Feature Pass 007).
 *
 * Three small MCP tools that expose targeted retrieval primitives at
 * deliberately small token caps:
 *
 *   - `define(entity)`        — single-paragraph definition, 256 tok cap.
 *   - `relate(a, b)`          — up to 3 atomic relationship statements
 *                                between two anchors, 768 tok cap.
 *   - `cite_sources(claim)`   — provenance citations for a claim, 512
 *                                tok cap.
 *
 * Each tool runs a single BM25 retrieval and renders a payload that fits
 * inside its budget. There is no daemon-side LLM call — the value is in
 * shipping precisely the structured slice the client LLM asked for, and
 * nothing more. The Codebase-Memory paper (arXiv 2603.27277) is the
 * reference for the "structural narrow query" pattern: 83%-quality answers
 * at ~10x token reduction vs. file-exploration.
 *
 * BM25-only commitment: the search path here is the same `WikiSearch`
 * instance the rest of the daemon uses. No vector embeddings.
 */
import type { ProvenanceChain } from "../provenance/chain.js";
import type { WikiSearch } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import { heuristicTokens } from "./token-estimator.js";
import {
  extractSectionLedes,
  extractSentencesContainingAll,
  firstParagraph,
  sentenceSplit,
  splitFrontmatter,
  truncateToTokenBudget,
} from "./truncate.js";

const DEFAULT_DEFINE_TOKENS = 256;
const DEFAULT_RELATE_TOKENS = 768;
const DEFAULT_CITE_TOKENS = 512;
const RELATE_MAX_STATEMENTS = 3;
const DEFINE_SEARCH_K = 5;
const RELATE_SEARCH_K = 10;
const CITE_SEARCH_K = 5;

export interface DefineOptions {
  store: WikiStore;
  search: WikiSearch;
  maxTokens?: number;
}

export interface DefineResult {
  entity: string;
  /** Definition text, truncated to the supplied token cap. */
  definition: string;
  /** Wiki-relative path of the source page. */
  source_page: string | null;
  /** BM25 score of the source page hit. */
  score: number | null;
  /** Approximate token count of `definition`. */
  tokens: number;
  /** True when no matching page was found. */
  no_hits: boolean;
}

/**
 * Resolve `entity` to the most relevant single-paragraph definition or
 * page lede. Falls back to the BM25 snippet when the page body can't be
 * read.
 */
export async function defineEntity(entity: string, opts: DefineOptions): Promise<DefineResult> {
  const budget = clampPositive(opts.maxTokens, DEFAULT_DEFINE_TOKENS);
  const hits = opts.search.search(entity, DEFINE_SEARCH_K);
  if (hits.length === 0) {
    return {
      entity,
      definition: "",
      source_page: null,
      score: null,
      tokens: 0,
      no_hits: true,
    };
  }
  const top = hits[0]!;
  const page = await opts.store.readPage(top.path);
  const body = page ? splitFrontmatter(page.raw || "").body || page.body : top.snippet;
  const definition = pickDefinition(body) || firstParagraph(body) || top.snippet;
  const truncated = truncateToTokenBudget(definition, budget);
  return {
    entity,
    definition: truncated,
    source_page: opts.store.relativePath(top.path),
    score: Number(top.score.toFixed(4)),
    tokens: heuristicTokens(truncated),
    no_hits: false,
  };
}

/**
 * Look for an explicit "Definition" section header or `**Definition**:` style
 * lead-in. Returns the matched paragraph if found, else null so the caller
 * can fall back to firstParagraph.
 */
function pickDefinition(body: string): string | null {
  // 1) "## Definition" / "### Definition" section header.
  const sectionMatch = /^#{1,6}\s+definition\s*$/im.exec(body);
  if (sectionMatch && sectionMatch.index !== undefined) {
    const after = body.slice(sectionMatch.index + sectionMatch[0].length);
    const paragraph = firstParagraph(after);
    if (paragraph) return paragraph;
  }
  // 2) "**Definition**:" inline lead-in.
  const inlineMatch = /^\s*(?:\*\*definition\*\*|definition)\s*:\s*(.+)$/im.exec(body);
  if (inlineMatch && inlineMatch[1]) {
    return inlineMatch[1].trim();
  }
  // 3) Per-section ledes that start with the word "is" or "are" (common
  //    encyclopedia opening) — return the first section whose lede looks
  //    definitional.
  for (const section of extractSectionLedes(body)) {
    if (/^[A-Z][^.]+(?:\bis\b|\bare\b)/.test(section.lede)) {
      return section.lede;
    }
  }
  return null;
}

export interface RelateOptions {
  store: WikiStore;
  search: WikiSearch;
  maxTokens?: number;
  /** Optional cap on relationship statements (default 3). */
  maxStatements?: number;
}

export interface RelationStatement {
  /** The relationship sentence, verbatim from the source page. */
  statement: string;
  /** Wiki-relative path of the page the sentence came from. */
  source_page: string;
  /** BM25 score of the source page when matched against entity_a + entity_b. */
  score: number;
}

export interface RelateResult {
  entity_a: string;
  entity_b: string;
  statements: RelationStatement[];
  tokens: number;
  no_hits: boolean;
}

/**
 * Find sentences that mention both `entity_a` and `entity_b`. We BM25-search
 * each anchor, intersect the result sets by page path (a page is a candidate
 * only if both anchors mention it), then scan each candidate's body for
 * sentences containing both anchor substrings.
 */
export async function relateEntities(
  entityA: string,
  entityB: string,
  opts: RelateOptions,
): Promise<RelateResult> {
  const budget = clampPositive(opts.maxTokens, DEFAULT_RELATE_TOKENS);
  const maxStatements = clampPositive(opts.maxStatements, RELATE_MAX_STATEMENTS);

  const hitsA = opts.search.search(entityA, RELATE_SEARCH_K);
  const hitsB = opts.search.search(entityB, RELATE_SEARCH_K);

  // Page path → best combined score (sum). Allows ranking the intersection
  // before we crack open page bodies.
  const combinedScores = new Map<string, number>();
  for (const h of hitsA) {
    combinedScores.set(h.path, h.score);
  }
  for (const h of hitsB) {
    const prev = combinedScores.get(h.path);
    if (prev !== undefined) combinedScores.set(h.path, prev + h.score);
    else combinedScores.delete(h.path);
  }
  // Only keep pages that appeared in BOTH result sets — that's our
  // intersection. Sort descending by combined score.
  const intersection = [...combinedScores.entries()]
    .filter(([, score]) => score > 0)
    .sort(([, a], [, b]) => b - a);

  if (intersection.length === 0) {
    return {
      entity_a: entityA,
      entity_b: entityB,
      statements: [],
      tokens: 0,
      no_hits: true,
    };
  }

  const statements: RelationStatement[] = [];
  let used = 0;
  for (const [pagePath, score] of intersection) {
    if (statements.length >= maxStatements) break;
    if (used >= budget) break;
    const page = await opts.store.readPage(pagePath);
    if (!page) continue;
    const remaining = budget - used;
    const sentences = extractSentencesContainingAll(page.body, [entityA, entityB], remaining);
    for (const s of sentences) {
      if (statements.length >= maxStatements) break;
      const block = `${s} _(${opts.store.relativePath(pagePath)})_`;
      const tokens = heuristicTokens(block);
      if (used + tokens > budget) break;
      statements.push({
        statement: s,
        source_page: opts.store.relativePath(pagePath),
        score: Number(score.toFixed(4)),
      });
      used += tokens;
    }
  }

  return {
    entity_a: entityA,
    entity_b: entityB,
    statements,
    tokens: used,
    no_hits: statements.length === 0,
  };
}

export interface CiteSourcesOptions {
  store: WikiStore;
  search: WikiSearch;
  provenance: ProvenanceChain | null;
  maxTokens?: number;
}

export interface CitationEntry {
  /** Wiki-relative path of the page the citation is for. */
  wiki_page: string;
  /** BM25 score of the wiki page hit. */
  score: number;
  /** Wiki page title for client-readable rendering. */
  title: string;
  /**
   * Raw source file paths that produced this wiki page. Sourced from the
   * provenance chain's `source_files` field.
   */
  source_files: string[];
  /** Short-hash prefix of the chain record for client-side referencing. */
  chain_hash: string;
  /** ISO timestamp of the provenance record. */
  timestamp: string;
  /** Provenance record type (ingest / heal / compound / query / etc). */
  type: string;
}

export interface CiteSourcesResult {
  claim: string;
  citations: CitationEntry[];
  tokens: number;
  no_hits: boolean;
  /** True when the daemon has no provenance subsystem enabled. */
  provenance_unavailable: boolean;
}

/**
 * Find the wiki pages that best match `claim`, then return the provenance
 * citations for each (which raw source files contributed, chain hash for
 * client-side cross-referencing). Caps at the requested token budget; if
 * the citations don't all fit, the top-scoring ones are kept.
 */
export async function citeSources(
  claim: string,
  opts: CiteSourcesOptions,
): Promise<CiteSourcesResult> {
  const budget = clampPositive(opts.maxTokens, DEFAULT_CITE_TOKENS);
  if (!opts.provenance) {
    return {
      claim,
      citations: [],
      tokens: 0,
      no_hits: false,
      provenance_unavailable: true,
    };
  }
  const hits = opts.search.search(claim, CITE_SEARCH_K);
  if (hits.length === 0) {
    return {
      claim,
      citations: [],
      tokens: 0,
      no_hits: true,
      provenance_unavailable: false,
    };
  }

  const citations: CitationEntry[] = [];
  let used = 0;
  for (const hit of hits) {
    if (used >= budget) break;
    const relPath = opts.store.relativePath(hit.path);
    // recordsFor matches against wiki_files_written, which in the
    // daemon's ingestion + heal pipelines stores relative paths.
    const records = await opts.provenance.recordsFor(relPath);
    if (records.length === 0) continue;
    // Use the most recent record so the citation reflects the page's
    // current provenance (most recent ingest or heal).
    const record = records[records.length - 1]!;
    const entry: CitationEntry = {
      wiki_page: relPath,
      score: Number(hit.score.toFixed(4)),
      title: hit.title,
      source_files: record.source_files,
      chain_hash: record.chain_hash.slice(0, 16),
      timestamp: record.timestamp,
      type: record.type,
    };
    const block = JSON.stringify(entry);
    const tokens = heuristicTokens(block);
    if (used + tokens > budget) break;
    citations.push(entry);
    used += tokens;
  }

  return {
    claim,
    citations,
    tokens: used,
    no_hits: citations.length === 0,
    provenance_unavailable: false,
  };
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/** Re-export sentence-split for downstream consumers (tests, benchmarks). */
export { sentenceSplit };
