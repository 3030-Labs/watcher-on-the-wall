/**
 * Progressive retrieval. The client LLM asks for the smallest viable
 * answer first; on signal, it expands tier by tier until it has enough
 * context. Each tier ships *new* content only — the client stitches the
 * conversation together. There is no daemon-side LLM call: this is pure
 * structural retrieval over the BM25 hit list, which is what makes it
 * dramatically cheaper than the synthesis-based `query` tool.
 *
 * Tiers:
 *   0. lede           – top hit's first paragraph (~150-300 tok)
 *   1. snippets       – next-2 hits' first paragraphs + outline of top-1
 *   2. section-ledes  – next-2 hits' bodies + per-section ledes of top-3
 *   3. full-bodies    – next-3 hits, full bodies of top-5
 *
 * Cumulative hit counts: tier 0 = 1, tier 1 = 3, tier 2 = 5, tier 3 = 8.
 * Each call returns the *delta* — never re-ships the previous tier.
 *
 * Token accounting uses the 4-char heuristic (`heuristicTokens`). A
 * separate `estimate_query_cost` MCP tool gives the client an exact-ish
 * estimate before they commit. The progressive flow itself enforces
 * `max_tokens_total` as a hard cap so a chatty client can't blow past
 * its budget by repeatedly expanding.
 *
 * BM25-only commitment: the search path here is the same `WikiSearch`
 * minisearch instance the rest of the daemon uses. No vector code paths,
 * no embedding fallback. If retrieval quality is the bottleneck, the
 * remedy is upstream (key_terms enrichment, query expansion) — not
 * vectors.
 */
import type { WikiSearch } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import type { CachedHit, ProgressiveCache, ProgressiveEntry } from "./progressive-cache.js";
import { heuristicTokens } from "./token-estimator.js";
import {
  extractOutline,
  extractSectionLedes,
  firstParagraph,
  renderOutlineEntry,
  splitFrontmatter,
  truncateToTokenBudget,
} from "./truncate.js";

/** 16 KB matches the existing query-engine page-body clamp. */
const MAX_PAGE_BODY_BYTES = 16 * 1024;

/** Cumulative hit counts per tier (tier 0 reveals 1, tier 1 → 3, etc). */
const HITS_PER_TIER: Record<number, number> = { 0: 1, 1: 3, 2: 5, 3: 8 };

/** Stable string labels surfaced in the response metadata. */
export const TIER_LABELS: Readonly<Record<number, string>> = {
  0: "lede",
  1: "snippets",
  2: "section-ledes",
  3: "full-bodies",
};

/** Highest tier index. Tier > MAX_TIER returns has_more: false. */
export const MAX_TIER = 3;

export interface ProgressiveTierResponse {
  /** Tier number (0-3) of the content delivered in this response. */
  tier: number;
  /** Human-readable label of the tier (lede / snippets / section-ledes / full-bodies). */
  tier_label: string;
  /**
   * Markdown content the client LLM consumes. Empty when has_more is
   * false and no further expansion is available.
   */
  content: string;
  /** Number of hits this tier added on top of the previous tier. */
  hit_count_delta: number;
  /** Total hits referenced across all tiers shipped so far. */
  hit_count_total: number;
  /** Approximate token count of `content` (heuristic). */
  tokens_delivered: number;
  /** Cumulative tokens shipped across all tiers in this conversation. */
  tokens_shipped_total: number;
  /** True if more tiers are available within max_tokens_total. */
  has_more: boolean;
  /** UUID to pass to query_expand. Null when has_more is false. */
  continuation_token: string | null;
  /** Label of the next tier the client could request. */
  next_tier_label: string | null;
  /** Heuristic estimate of next-tier token cost. */
  next_tier_estimate_tokens: number | null;
}

export interface ProgressiveQueryOptions {
  /** Source-of-truth wiki store for reading pages by absolute path. */
  store: WikiStore;
  /** BM25 search index. */
  search: WikiSearch;
  /** Continuation cache. */
  cache: ProgressiveCache;
  /** Initial token budget (default 512). */
  maxTokensInitial?: number;
  /** Hard cap on total tokens across all expand calls (default 8192). */
  maxTokensTotal?: number;
}

/**
 * Run BM25, pre-fetch the top-N page bodies, render tier 0, and persist a
 * continuation for `query_expand`. Returns the tier-0 response or — when
 * the corpus is empty / no hits found — a response with no content and
 * has_more: false.
 */
export async function queryProgressive(
  question: string,
  opts: ProgressiveQueryOptions,
): Promise<ProgressiveTierResponse> {
  const maxInitial = clampPositive(opts.maxTokensInitial, 512);
  const maxTotal = clampPositive(opts.maxTokensTotal, 8192);
  const initialBudget = Math.min(maxInitial, maxTotal);

  if (opts.search.size() === 0 && opts.store.count() > 0) {
    return emptyResponse(0, "search index is empty — rebuild required");
  }

  const hits = opts.search.search(question, HITS_PER_TIER[MAX_TIER]);
  if (hits.length === 0) {
    return emptyResponse(0, "no matching pages");
  }

  const cachedHits = await prefetchHits(opts.store, hits);

  const content = renderTier(0, cachedHits, [], initialBudget);
  const tokens = heuristicTokens(content);

  const hitCountTotal = HITS_PER_TIER[0]!;
  const hasMoreTiers = MAX_TIER > 0;
  const tokensRemaining = maxTotal - tokens;
  const hasMore = hasMoreTiers && tokensRemaining > 0 && cachedHits.length > hitCountTotal;

  const continuation = opts.cache.put({
    question,
    hits: cachedHits,
    lastTierServed: 0,
    tokensShippedSoFar: tokens,
    maxTokensTotal: maxTotal,
  });

  return {
    tier: 0,
    tier_label: TIER_LABELS[0]!,
    content,
    hit_count_delta: HITS_PER_TIER[0]!,
    hit_count_total: hitCountTotal,
    tokens_delivered: tokens,
    tokens_shipped_total: tokens,
    has_more: hasMore,
    continuation_token: hasMore ? continuation : null,
    next_tier_label: hasMore ? TIER_LABELS[1]! : null,
    next_tier_estimate_tokens: hasMore ? estimateNextTierTokens(1, cachedHits) : null,
  };
}

export interface QueryExpandOptions {
  cache: ProgressiveCache;
  additionalTokens?: number;
}

/**
 * Advance one tier on a previously-issued continuation. Returns the delta
 * content (i.e., only the new hits the next tier reveals). Returns
 * `{ error }` if the continuation is unknown or the total budget is
 * exhausted.
 */
export async function queryExpand(
  continuationToken: string,
  opts: QueryExpandOptions,
): Promise<ProgressiveTierResponse | { error: string }> {
  const entry = opts.cache.get(continuationToken);
  if (!entry) {
    return { error: "continuation_token expired or invalid" };
  }

  if (entry.lastTierServed >= MAX_TIER) {
    return { error: "no further tiers available" };
  }

  const additional = clampPositive(opts.additionalTokens, 1024);
  const totalRemaining = entry.maxTokensTotal - entry.tokensShippedSoFar;
  const budget = Math.min(additional, Math.max(0, totalRemaining));
  if (budget <= 0) {
    return { error: "max_tokens_total budget exhausted" };
  }

  const nextTier = entry.lastTierServed + 1;
  const previousHitCount = HITS_PER_TIER[entry.lastTierServed] ?? 0;
  const newHits = entry.hits.slice(previousHitCount, HITS_PER_TIER[nextTier]);

  const content = renderTier(nextTier, entry.hits, newHits, budget);
  const tokens = heuristicTokens(content);

  // Capture the previous-shipped count *before* the mutator runs — the
  // cache update mutates `entry` in place (same reference), so reading
  // tokensShippedSoFar after the update double-counts the delta.
  const previousShipped = entry.tokensShippedSoFar;
  opts.cache.update(continuationToken, (e) => {
    e.lastTierServed = nextTier;
    e.tokensShippedSoFar += tokens;
  });

  const tokensTotal = previousShipped + tokens;
  const tokensLeftover = entry.maxTokensTotal - tokensTotal;
  const hasMore = nextTier < MAX_TIER && tokensLeftover > 0;

  return {
    tier: nextTier,
    tier_label: TIER_LABELS[nextTier]!,
    content,
    hit_count_delta: newHits.length,
    hit_count_total: HITS_PER_TIER[nextTier]!,
    tokens_delivered: tokens,
    tokens_shipped_total: tokensTotal,
    has_more: hasMore,
    continuation_token: hasMore ? continuationToken : null,
    next_tier_label: hasMore ? TIER_LABELS[nextTier + 1]! : null,
    next_tier_estimate_tokens: hasMore ? estimateNextTierTokens(nextTier + 1, entry.hits) : null,
  };
}

/** Pre-fetch the page bodies for a batch of hits, in parallel. */
async function prefetchHits(
  store: WikiStore,
  hits: ReturnType<WikiSearch["search"]>,
): Promise<CachedHit[]> {
  return Promise.all(
    hits.map(async (hit) => {
      let body = "";
      let truncated = false;
      try {
        const page = await store.readPage(hit.path);
        if (page) {
          if (page.body.length > MAX_PAGE_BODY_BYTES) {
            body = page.body.slice(0, MAX_PAGE_BODY_BYTES);
            truncated = true;
          } else {
            body = page.body;
          }
        } else {
          body = hit.snippet;
        }
      } catch {
        body = hit.snippet;
      }
      return {
        hit,
        body,
        relativePath: store.relativePath(hit.path),
        truncated,
      };
    }),
  );
}

function renderTier(
  tier: number,
  allHits: CachedHit[],
  deltaHits: CachedHit[],
  budget: number,
): string {
  if (budget <= 0) return "";
  switch (tier) {
    case 0:
      return renderTier0(allHits[0], budget);
    case 1:
      return renderTier1(allHits[0], allHits.slice(1, HITS_PER_TIER[1]), budget);
    case 2:
      return renderTier2(allHits.slice(0, HITS_PER_TIER[1]), deltaHits, budget);
    case 3:
      return renderTier3(allHits.slice(0, HITS_PER_TIER[2]), deltaHits, budget);
    default:
      return "";
  }
}

/** Tier 0: top hit's lede paragraph. Cheapest possible payload. */
function renderTier0(top: CachedHit | undefined, budget: number): string {
  if (!top) return "";
  const header = `## ${top.hit.title}\n_path: ${top.relativePath} · score: ${top.hit.score.toFixed(3)}_\n\n`;
  const headerTokens = heuristicTokens(header);
  const remaining = budget - headerTokens;
  if (remaining <= 0) return truncateToTokenBudget(header, budget);
  const lede = firstParagraph(splitFrontmatter(top.body).body) || top.hit.snippet;
  return `${header}${truncateToTokenBudget(lede, remaining)}`.trim();
}

/**
 * Tier 1: top hit's outline + next-2 hits' ledes. Gives the client LLM a
 * map of what's available without committing to full sections.
 */
function renderTier1(top: CachedHit | undefined, next: CachedHit[], budget: number): string {
  const sections: string[] = [];
  let used = 0;

  if (top) {
    const outline = extractOutline(top.body);
    if (outline.length > 0) {
      const lines = [`## Outline: ${top.hit.title}`, `_path: ${top.relativePath}_`, ""];
      for (const entry of outline) lines.push(renderOutlineEntry(entry));
      const text = `${lines.join("\n")}\n`;
      const tokens = heuristicTokens(text);
      if (used + tokens <= budget) {
        sections.push(text);
        used += tokens;
      }
    }
  }

  // Per-hit slice MUST NOT enforce a minimum that exceeds the remaining
  // budget — that would let the cumulative render overshoot the cap.
  const perHit = next.length > 0 ? Math.max(0, Math.floor((budget - used) / next.length)) : 0;
  for (const h of next) {
    if (used >= budget) break;
    const remaining = budget - used;
    const block = renderHitLede(h, Math.min(perHit, remaining));
    const tokens = heuristicTokens(block);
    if (used + tokens > budget) break;
    sections.push(block);
    used += tokens;
  }
  return sections.join("\n").trim();
}

/**
 * Tier 2: per-section ledes for top-3 hits + next-2 hits' ledes. The
 * client LLM now sees the structure of the most relevant pages without
 * paying for the prose between section headers.
 */
function renderTier2(top3: CachedHit[], deltaHits: CachedHit[], budget: number): string {
  const sections: string[] = [];
  let used = 0;

  const perTop = top3.length > 0 ? Math.max(0, Math.floor((budget * 0.6) / top3.length)) : 0;
  for (const h of top3) {
    if (used >= budget) break;
    const remaining = budget - used;
    const block = renderHitSectionLedes(h, Math.min(perTop, remaining));
    const tokens = heuristicTokens(block);
    if (used + tokens > budget) break;
    sections.push(block);
    used += tokens;
  }

  const perDelta =
    deltaHits.length > 0 ? Math.max(0, Math.floor((budget - used) / deltaHits.length)) : 0;
  for (const h of deltaHits) {
    if (used >= budget) break;
    const remaining = budget - used;
    const block = renderHitLede(h, Math.min(perDelta, remaining));
    const tokens = heuristicTokens(block);
    if (used + tokens > budget) break;
    sections.push(block);
    used += tokens;
  }
  return sections.join("\n").trim();
}

/**
 * Tier 3: full bodies (already clamped to MAX_PAGE_BODY_BYTES at pre-fetch).
 * This is the only tier whose payload matches the legacy `query` tool's
 * fanout. Used when the client LLM has decided it needs to see the
 * complete material.
 */
function renderTier3(top5: CachedHit[], deltaHits: CachedHit[], budget: number): string {
  const sections: string[] = [];
  let used = 0;

  const all = [...deltaHits];
  // Tier 3 is the deepest tier; if top5 hasn't been served at full body yet
  // (i.e., we're being called fresh from tier 2 → 3 and the client wants
  // *all* the bodies), include them. The cache state guarantees we don't
  // re-ship the same hits, so deltaHits is the typical population here.
  if (top5.length > 0 && deltaHits.length === 0) {
    // Defensive: should not happen given our tier indices.
    all.push(...top5);
  }

  const perHit = all.length > 0 ? Math.max(0, Math.floor(budget / all.length)) : 0;
  for (const h of all) {
    if (used >= budget) break;
    const remaining = budget - used;
    const block = renderHitFullBody(h, Math.min(perHit, remaining));
    const tokens = heuristicTokens(block);
    if (used + tokens > budget) break;
    sections.push(block);
    used += tokens;
  }
  return sections.join("\n").trim();
}

function renderHitLede(hit: CachedHit, budget: number): string {
  if (budget <= 0) return "";
  const header = `## ${hit.hit.title}\n_path: ${hit.relativePath} · score: ${hit.hit.score.toFixed(3)}_\n\n`;
  const headerTokens = heuristicTokens(header);
  const remaining = Math.max(0, budget - headerTokens);
  const lede = firstParagraph(splitFrontmatter(hit.body).body) || hit.hit.snippet;
  return `${header}${truncateToTokenBudget(lede, remaining)}`.trimEnd();
}

function renderHitSectionLedes(hit: CachedHit, budget: number): string {
  if (budget <= 0) return "";
  const header = `## ${hit.hit.title}\n_path: ${hit.relativePath} · score: ${hit.hit.score.toFixed(3)}_\n\n`;
  const headerTokens = heuristicTokens(header);
  let remaining = Math.max(0, budget - headerTokens);

  const ledes = extractSectionLedes(hit.body);
  if (ledes.length === 0) {
    const lede = firstParagraph(splitFrontmatter(hit.body).body) || hit.hit.snippet;
    return `${header}${truncateToTokenBudget(lede, remaining)}`.trimEnd();
  }

  const out: string[] = [header];
  for (const section of ledes) {
    if (remaining <= 0) break;
    const title = section.header ? `### ${section.header.title}` : "";
    const block = section.header ? `${title}\n${section.lede}\n` : `${section.lede}\n`;
    const tokens = heuristicTokens(block);
    if (tokens <= remaining) {
      out.push(block);
      remaining -= tokens;
    } else {
      // Squeeze a truncated lede in if there is meaningful budget left.
      if (remaining > heuristicTokens(title) + 8) {
        const truncated = truncateToTokenBudget(
          section.lede,
          remaining - heuristicTokens(title) - 2,
        );
        out.push(`${title}\n${truncated}\n`);
        remaining = 0;
      }
      break;
    }
  }
  return out.join("").trimEnd();
}

function renderHitFullBody(hit: CachedHit, budget: number): string {
  if (budget <= 0) return "";
  const header = `## ${hit.hit.title}\n_path: ${hit.relativePath} · score: ${hit.hit.score.toFixed(3)}${
    hit.truncated ? " · [pre-fetch truncated]" : ""
  }_\n\n`;
  const headerTokens = heuristicTokens(header);
  const remaining = Math.max(0, budget - headerTokens);
  const body = splitFrontmatter(hit.body).body || hit.body;
  return `${header}${truncateToTokenBudget(body, remaining)}`.trimEnd();
}

function estimateNextTierTokens(nextTier: number, hits: CachedHit[]): number {
  // Rough envelope: per-tier average payload size, capped by the
  // available material. This is a hint for the client LLM, not a hard
  // guarantee; the actual delivered count is returned in tokens_delivered.
  switch (nextTier) {
    case 1: {
      const sample = hits.slice(0, HITS_PER_TIER[1]);
      const approx = sample.reduce(
        (acc, h) => acc + heuristicTokens(firstParagraph(splitFrontmatter(h.body).body) || ""),
        0,
      );
      return Math.min(approx, 1200);
    }
    case 2: {
      const sample = hits.slice(0, HITS_PER_TIER[2]);
      const approx = sample.reduce((acc, h) => {
        const ledes = extractSectionLedes(h.body);
        return acc + ledes.reduce((sum, s) => sum + heuristicTokens(s.lede), 0);
      }, 0);
      return Math.min(approx, 3000);
    }
    case 3: {
      const sample = hits.slice(0, HITS_PER_TIER[3]);
      const approx = sample.reduce(
        (acc, h) => acc + heuristicTokens(splitFrontmatter(h.body).body || h.body),
        0,
      );
      return Math.min(approx, 8000);
    }
    default:
      return 0;
  }
}

function emptyResponse(tier: number, reason: string): ProgressiveTierResponse {
  return {
    tier,
    tier_label: TIER_LABELS[tier]!,
    content: `_${reason}_`,
    hit_count_delta: 0,
    hit_count_total: 0,
    tokens_delivered: heuristicTokens(reason) + 2,
    tokens_shipped_total: heuristicTokens(reason) + 2,
    has_more: false,
    continuation_token: null,
    next_tier_label: null,
    next_tier_estimate_tokens: null,
  };
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

/**
 * Exposed for tests + benchmark. Reuses the same retrieval/render path
 * `queryProgressive` does, then expands all the way to `maxTier` without
 * touching the cache. Returns the cumulative rendered content + token
 * count so a benchmark can compare against the legacy `query` tool's full
 * payload.
 */
export async function renderProgressiveCumulative(
  question: string,
  opts: {
    store: WikiStore;
    search: WikiSearch;
    maxTier: number;
    perTierBudget?: number;
  },
): Promise<{ content: string; tokens: number; hits: number }> {
  const hits = opts.search.search(question, HITS_PER_TIER[MAX_TIER]);
  if (hits.length === 0) return { content: "", tokens: 0, hits: 0 };
  const cachedHits = await prefetchHits(opts.store, hits);

  const target = Math.min(opts.maxTier, MAX_TIER);
  const tierBudget = opts.perTierBudget ?? 1024;
  let combined = "";
  for (let tier = 0; tier <= target; tier++) {
    const previousHitCount = tier === 0 ? 0 : HITS_PER_TIER[tier - 1]!;
    const deltaHits = cachedHits.slice(previousHitCount, HITS_PER_TIER[tier]);
    const piece = renderTier(tier, cachedHits, deltaHits, tierBudget);
    combined += (combined ? "\n\n" : "") + piece;
  }
  return {
    content: combined,
    tokens: heuristicTokens(combined),
    hits: Math.min(HITS_PER_TIER[target] ?? 0, cachedHits.length),
  };
}

/** Re-export for downstream consumers (tools.ts, tests). */
export type { ProgressiveEntry, CachedHit };
