# Feature Pass 005 — Progressive Retrieval

**Date:** 2026-05-23
**Base:** v0.6.0 (post Layer-1 remediation; commit `b421024`)
**Target image:** v0.7.0
**Group:** Pass A (Context Efficiency)

---

## Feature shipped

Two additive MCP tools that let a client LLM consume the wiki as a
memory tier without burning its context window:

- **`query_progressive(question, max_tokens_initial, max_tokens_total)`**
  — runs BM25 retrieval once, pre-fetches the top-8 page bodies, ships
  the smallest viable answer (tier 0 = top hit's lede paragraph) along
  with a `continuation_token` for tier expansion.
- **`query_expand(continuation_token, additional_tokens)`** — advances
  one tier, returning only the new content the next tier reveals.

Tier shape:

| tier | label | content | typical tokens |
|---|---|---|---|
| 0 | `lede` | top hit's first paragraph | 100-300 |
| 1 | `snippets` | top hit's outline + next-2 hits' ledes | 500-1500 |
| 2 | `section-ledes` | top-3 hits' per-section ledes + next-2 hits' ledes | 1500-3000 |
| 3 | `full-bodies` | top-8 hits' full bodies (matches legacy `query` fanout) | 3000-8000 |

**Pure structural retrieval — no daemon-side LLM call.** That's what
makes the saving real on both sides of the wire.

---

## Files

### New source files
| File | Purpose |
|---|---|
| `src/server/truncate.ts` | Sentence-boundary truncation utility (also shared with FP-006/007) |
| `src/server/progressive-cache.ts` | In-memory TTL+LRU cache for continuation tokens (5 min TTL, 100-entry cap) |
| `src/server/progressive-query.ts` | Tier renderers + `queryProgressive` / `queryExpand` handlers + benchmark-facing `renderProgressiveCumulative` |

### Modified
| File | Change |
|---|---|
| `src/server/tools.ts` | Register `query_progressive` + `query_expand`; extend `ToolRegistrationContext` with `progressiveCache` |
| `src/server/index.ts` | Instantiate `ProgressiveCache` as a singleton on `McpHttpServer`; pass through to `registerTools` |
| `vitest.config.ts` | Include `*.bench.ts` in test runs |

### New tests
| File | Tests | Coverage |
|---|---|---|
| `test/unit/mcp/query-progressive.test.ts` | 7 | happy path, empty corpus, malformed input, budget enforcement, tier-by-tier escalation, BM25-only regression |
| `test/unit/mcp/query-expand.test.ts` | 5 | happy path, invalid token, budget exhaustion, malformed input, budget enforcement |
| `test/unit/mcp/truncate.test.ts` | 18 | tokensToChars/charsToTokens, sentence-boundary cuts, frontmatter strip, outline extraction, section-ledes, sentence-split + anchor-containing |
| `test/unit/mcp/progressive-cache.test.ts` | 6 | put/get round-trip, missing tokens, mutator updates, delete, LRU eviction, TTL expiry |

---

## Design notes

### Why structural over synthesis

`query` (the legacy tool) burns ~32 KB of input tokens on the daemon's
LLM to synthesize an answer the client then receives in compressed form
(~500-2000 tokens). For the client to *reason* over the wiki — to
expand on a particular hit, to follow a citation, to compare two
sources — the synthesis path is a one-shot dead end.

Progressive retrieval inverts that: ship the smallest viable raw
fragment first, let the client LLM signal "I need more" by calling
`query_expand`, expand by tiers. The daemon does zero LLM work; the
client pays only for what it actually reads.

### Continuation tokens

`query_progressive` writes an entry to `ProgressiveCache` keyed by a
fresh UUID. Each cached entry holds the question, the pre-fetched
top-8 hits (with bodies clamped to 16 KB), the `lastTierServed` index,
and the running `tokensShippedSoFar` count. Entries TTL at **5 minutes
from last touch** and LRU-evict at **100 entries** to bound process
memory. The cache lives on the long-lived `McpHttpServer` instance so
a client's tier-0 call and follow-up tier-1 expand hit the same state,
even though each `/mcp` request constructs a fresh `McpServer`.

### Token-budget enforcement

The `max_tokens_total` cap is the hard backstop. Each
`query_expand` call computes
`budget = min(additional_tokens, max_tokens_total - tokensShippedSoFar)`
and refuses (`{ error: "max_tokens_total budget exhausted" }`) when the
budget would be ≤ 0. The renderers themselves never overshoot the
per-call budget — every per-hit slice is `Math.floor((budget - used) /
n)`; no minimum that could exceed the remaining cap.

The tier-0 → tier-1 → tier-2 → tier-3 chain in the unit tests verifies
this assertion is sound for at least one realistic walk.

### Sentence-boundary truncation

`truncateToTokenBudget(text, maxTokens)` in `src/server/truncate.ts`
converts tokens to a char budget (4 chars/token), then prefers a
sentence-boundary cut (`.` / `!` / `?` followed by whitespace or
end-of-string), falling back to a word boundary if no sentence
terminator sits within 30% of the budget from the end. Never mid-token.

---

## Benchmark snapshot

Run via `pnpm vitest run test/bench/`. All four fixtures cleared the
60% reduction target by a wide margin:

| fixture | baseline | tier-0 | reduction |
|---|---|---|---|
| F1-photosynthesis | 466 tok | 22 tok | **95.3%** |
| F4-rust-borrow-checker | 469 tok | 24 tok | **94.9%** |
| small-corpus (10 pages) | 268 tok | 35 tok | **86.9%** |
| large-corpus (~100 pages) | 1300 tok | 18 tok | **98.6%** |

See [`CONTEXT-EFFICIENCY-PASS-A.md`](CONTEXT-EFFICIENCY-PASS-A.md) for the
combined Pass A numbers and recommended Group B sequencing.

---

## Hard gates

- ✓ Backwards compatible (legacy `query` unchanged)
- ✓ BM25-only commitment preserved (regression guard test enforces no
  vector imports)
- ✓ Pass 008 BYOK invariants preserved (no LLM call → no key touched)
- ✓ AGPL boundary preserved (no wotw-cloud imports)
- ✓ All 7 daemon gates green
- ✓ 60% reduction demonstrated on all 4 fixtures

---

## Out of scope (deferred to Group B)

- Fact-level retrieval layer (atomic-fact decomposition at ingest time
  per Li/TTIC + Cambridge ALTA)
- Synthetic question generation at ingestion (would let `define`/`relate`
  hit pre-computed candidates instead of running BM25)
- Schema changes (none needed for Pass A)
- wotw-cloud changes (none needed for Pass A)
