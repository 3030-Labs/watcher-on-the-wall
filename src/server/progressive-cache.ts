/**
 * In-memory cache for progressive-retrieval continuations.
 *
 * `query_progressive` runs BM25 retrieval once, pre-fetches the top-k page
 * bodies, and ships the smallest viable answer (tier 0) to the client LLM.
 * `query_expand` is called with a continuation_token to receive higher
 * tiers without re-doing the search. This module owns the short-lived
 * keyed state that makes that two-step flow possible.
 *
 * Invariants:
 *   - Entries expire 5 minutes after creation (TTL). After that, the
 *     continuation_token is considered invalid and the client must call
 *     query_progressive again.
 *   - LRU eviction caps the cache at MAX_ENTRIES; the oldest *touched*
 *     entry is dropped first, not the oldest *created*.
 *   - All state is in-memory and per-daemon-process. Restarting the daemon
 *     invalidates every continuation_token — that's intentional. The cache
 *     is a session-scoped optimisation, not durable storage.
 *
 * BYOK / Pass 008 invariants: nothing in this cache touches API keys; the
 * cache stores question text + retrieved page bodies, all of which are
 * already inside the daemon's trust boundary (read from the local wiki).
 */
import { randomUUID } from "node:crypto";
import type { SearchHit } from "../wiki/search.js";

/** A single cached hit: the BM25 search result plus the page body. */
export interface CachedHit {
  hit: SearchHit;
  /** Full page body (frontmatter stripped). */
  body: string;
  /** Wiki-relative path. */
  relativePath: string;
  /** True if the body was clamped during pre-fetch. */
  truncated: boolean;
}

/** State persisted between `query_progressive` and `query_expand` calls. */
export interface ProgressiveEntry {
  /** Original natural-language question. */
  question: string;
  /** Ranked BM25 hits with pre-fetched bodies. */
  hits: CachedHit[];
  /**
   * Highest tier the caller has consumed (0-3). `query_expand` starts at
   * `lastTierServed + 1`. The progressive-query handler updates this on
   * every successful return.
   */
  lastTierServed: number;
  /** Tokens already shipped to the caller (sum across tiers). */
  tokensShippedSoFar: number;
  /** Cap on the total tokens this conversation may consume. */
  maxTokensTotal: number;
  /** ISO timestamp the entry was created. */
  createdAt: string;
  /** Last access timestamp (ms). Updated on every touch for LRU semantics. */
  lastAccessMs: number;
}

const TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_ENTRIES = 100;

/** Map of continuation_token → entry. */
type CacheMap = Map<string, ProgressiveEntry>;

export class ProgressiveCache {
  private readonly entries: CacheMap = new Map();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(opts: { ttlMs?: number; maxEntries?: number } = {}) {
    this.ttlMs = opts.ttlMs ?? TTL_MS;
    this.maxEntries = opts.maxEntries ?? MAX_ENTRIES;
  }

  /**
   * Insert a new entry. Returns the freshly-generated continuation_token
   * the caller passes back to `query_expand`.
   */
  put(entry: Omit<ProgressiveEntry, "createdAt" | "lastAccessMs">): string {
    this.evictExpired();
    if (this.entries.size >= this.maxEntries) this.evictLru();
    const token = randomUUID();
    const now = Date.now();
    this.entries.set(token, {
      ...entry,
      createdAt: new Date(now).toISOString(),
      lastAccessMs: now,
    });
    return token;
  }

  /**
   * Fetch an entry by continuation_token. Touches its last-access stamp so
   * LRU eviction reflects actual usage. Returns null if missing or expired.
   */
  get(token: string): ProgressiveEntry | null {
    const entry = this.entries.get(token);
    if (!entry) return null;
    if (Date.now() - entry.lastAccessMs > this.ttlMs) {
      this.entries.delete(token);
      return null;
    }
    entry.lastAccessMs = Date.now();
    return entry;
  }

  /** Replace an existing entry (e.g. after advancing the tier). */
  update(token: string, mutator: (entry: ProgressiveEntry) => void): boolean {
    const entry = this.get(token);
    if (!entry) return false;
    mutator(entry);
    entry.lastAccessMs = Date.now();
    return true;
  }

  /** Drop an entry explicitly. No-op if not present. */
  delete(token: string): void {
    this.entries.delete(token);
  }

  /** Number of live (non-expired) entries. */
  size(): number {
    this.evictExpired();
    return this.entries.size;
  }

  /** Drop every expired entry. */
  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [token, entry] of this.entries) {
      if (entry.lastAccessMs < cutoff) this.entries.delete(token);
    }
  }

  /** Drop the least-recently-accessed entry. */
  private evictLru(): void {
    let oldestToken: string | null = null;
    let oldestStamp = Number.POSITIVE_INFINITY;
    for (const [token, entry] of this.entries) {
      if (entry.lastAccessMs < oldestStamp) {
        oldestStamp = entry.lastAccessMs;
        oldestToken = token;
      }
    }
    if (oldestToken) this.entries.delete(oldestToken);
  }
}
