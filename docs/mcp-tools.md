# MCP tools

`wotw` exposes its knowledge base over the
[Model Context Protocol](https://modelcontextprotocol.io) using a
stateless streamable-HTTP transport. Any MCP-capable client can connect
to `http://<host>:<port>/mcp` with (optionally) a `Authorization: Bearer
<token>` header.

The `/healthz` endpoint is unauthenticated and returns `{ ok: true }`
for liveness probes.

---

## Tools

### `search`

Full-text search over the wiki using minisearch. Natural-language
queries are OR-combined, so `"what is a hash chain"` will still match
pages that only contain `hash chain`.

```json
{
  "name": "search",
  "arguments": { "query": "hash chain", "limit": 10, "domain": "security", "scope": "my-project" }
}
```

`domain` and `scope` are optional pre-filters. When provided, only
pages whose frontmatter matches (case-insensitive) are returned.
Omitting both searches everything (backward compatible).

Returns an array of `{ title, category, path, score, snippet }`.

### `list_pages`

List every wiki page, optionally filtered by category.

```json
{ "name": "list_pages", "arguments": { "category": "concept" } }
```

### `read_page`

Read the full markdown content of a single page by its wiki-relative
path. Paths containing `..` are rejected.

```json
{ "name": "read_page", "arguments": { "path": "wiki/concepts/hash-chains.md" } }
```

### `query`

Answer a natural-language question grounded in the wiki. Returns an
answer with `[citation]` markers plus a JSON blob with the source pages,
cost, model, and duration.

```json
{
  "name": "query",
  "arguments": {
    "question": "what is a hash chain?",
    "k": 8,
    "domain": "security",
    "scope": "my-project"
  }
}
```

`k` is the number of wiki pages retrieved as context (default 8, max 20).
`domain` and `scope` narrow the search to pages matching those metadata
values (same behavior as the `search` tool).

### `get_index`

Return the current contents of `wiki/index.md` (auto-generated,
sentinel-delimited).

### `get_stats`

Return counts of wiki pages by category, today's cost, the number of
indexed documents, the number of pages with `status: orphaned` in
their frontmatter, and the number of permanently-failed ingestion
batches in the dead-letter queue.

```json
{
  "total": 42,
  "by_category": { "concept": 30, "entity": 8, "synthesis": 4 },
  "cost_today_usd": 0.183,
  "indexed_documents": 42,
  "orphaned_pages": 2,
  "failed_batches": 0,
  "health": {
    "avg_score": 78,
    "pages_below_50": 3,
    "lowest_scoring_page": "wiki/concepts/old-topic.md"
  },
  "query_health": {
    "total_queries": 150,
    "zero_hits": 12,
    "zero_hit_rate": 0.08,
    "recent_zero_hit_queries": ["quantum computing", "wormholes"]
  }
}
```

`orphaned_pages` counts pages whose source files were deleted (see
the deletion/archive flow in [docs/architecture.md](architecture.md#deletions)).
`failed_batches` reflects the line count of
`ingestion.dead_letter_file`; when the dead-letter queue is disabled
(empty path) this field is always `0`. `health` includes the average
health score, the count of pages scoring below 50, and the
lowest-scoring page path (see [knowledge-health.md](knowledge-health.md)).
`query_health` shows the zero-hit rate from the query log (last 7 days)
— see [retrieval-hardening.md](retrieval-hardening.md#feature-4-zero-hit-monitoring--vocabulary-enrichment).

### `related_pages`

Return the `related:`, `tags:`, and `sources:` frontmatter of a given
page.

```json
{ "name": "related_pages", "arguments": { "path": "wiki/concepts/hash-chains.md" } }
```

### `get_provenance_log`

Return the N most recent provenance records, or all records that
touched a specific wiki page.

```json
{
  "name": "get_provenance_log",
  "arguments": { "limit": 20, "path": "wiki/concepts/hash-chains.md" }
}
```

Returns a JSON object `{ total, returned, records }` where each
record has truncated ids and chain hashes for readability.

### `verify_provenance`

Walk the entire provenance chain, recomputing every id and chain hash.
Returns a verification report and sets `isError: true` if the chain is
tampered.

```json
{
  "ok": true,
  "total": 42,
  "verified": 42,
  "errors": [],
  "head": "…",
  "signature": "…"
}
```

### `synthesize`

Trigger a compounding synthesis pass immediately. Budget-gated and
idempotent — existing syntheses covering a cluster are skipped.

```json
{
  "skipped": false,
  "skip_reason": null,
  "clusters": 3,
  "pages_written": 3,
  "cost_usd": 0.043,
  "git_sha": "abc123…",
  "duration_ms": 8421
}
```

---

## Context-efficient retrieval tools (Pass A)

The tools below ship in **v0.7.0** to give client LLMs ways to consume
wotw as a memory tier without burning their context window. They are
**additive** — the existing `query`, `search`, `read_page` tools are
unchanged. Three feature passes shipped together:

- **Feature Pass 005** — progressive retrieval (`query_progressive`,
  `query_expand`)
- **Feature Pass 006** — token-budget estimation (`estimate_query_cost`)
- **Feature Pass 007** — structural narrow-query primitives (`define`,
  `relate`, `cite_sources`)

All three pass groups are pure BM25 + structural; **no daemon-side LLM
call**. This is also what makes the tools dramatically cheaper for the
client than the synthesis-based `query` tool: when measured on the
benchmark fixtures, the progressive-flow tier-0 payload is **86-99%
smaller** than the legacy retrieval payload (see
`test/bench/context-efficiency.bench.ts` and
[`CONTEXT-EFFICIENCY-PASS-A.md`](../CONTEXT-EFFICIENCY-PASS-A.md)).

### `query_progressive`

Retrieve the smallest viable answer first (tier 0 = top hit's lede
paragraph), with a `continuation_token` to expand to higher tiers on
signal. **Pure structural retrieval — no daemon-side LLM synthesis.**

```json
{
  "name": "query_progressive",
  "arguments": {
    "question": "what is photosynthesis?",
    "max_tokens_initial": 512,
    "max_tokens_total": 8192
  }
}
```

Tier shape:

| tier | label | content | typical tokens |
|---|---|---|---|
| 0 | `lede` | top hit's first paragraph | 100-300 |
| 1 | `snippets` | top hit's outline + next-2 hits' ledes | 500-1500 |
| 2 | `section-ledes` | top-3 hits' per-section ledes + next-2 hits' ledes | 1500-3000 |
| 3 | `full-bodies` | top-8 hits' full bodies (matches legacy `query` fanout) | 3000-8000 |

Returns two content blocks: the rendered markdown and a JSON metadata
blob:

```json
{
  "tier": 0,
  "tier_label": "lede",
  "hit_count_delta": 1,
  "hit_count_total": 1,
  "tokens_delivered": 287,
  "tokens_shipped_total": 287,
  "has_more": true,
  "continuation_token": "f7c4e2d8-1a3b-4e7f-9c2d-5b8a4f3e1c9b",
  "next_tier_label": "snippets",
  "next_tier_estimate_tokens": 1200
}
```

`max_tokens_total` is a **hard cap** across all subsequent
`query_expand` calls — once exhausted, expand returns an error.
Continuation tokens TTL at **5 minutes** and the cache holds the most
recent 100 entries.

### `query_expand`

Advance one tier on a prior `query_progressive` call. Returns **only the
new content** the next tier reveals (clients stitch the conversation
together).

```json
{
  "name": "query_expand",
  "arguments": {
    "continuation_token": "f7c4e2d8-...",
    "additional_tokens": 1024
  }
}
```

Possible error responses (returned as `isError: true`):
- `continuation_token expired or invalid` — token unknown or TTL
  exceeded
- `no further tiers available` — already at tier 3
- `max_tokens_total budget exhausted` — total budget consumed

### `estimate_query_cost`

Pre-flight token estimate so the client LLM knows what the retrieval
payload would cost **before** committing. Identical retrieval-assembly
math to the legacy `query` tool, so the estimate reflects the real
on-the-wire payload.

```json
{
  "name": "estimate_query_cost",
  "arguments": {
    "question": "what is photosynthesis?",
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "precise": false,
    "k": 8
  }
}
```

- `provider` (optional) — `anthropic` | `openai` | `gemini` | `ollama`.
  Defaults to the `WOTW_LLM_PROVIDER` env var, falling back to the
  daemon's configured provider. Omit both and you get a 4-row
  comparison.
- `precise` (default `false`) — when `true`, the daemon uses the
  provider's native tokenizer (Anthropic `messages.countTokens()` or
  Gemini `countTokens()` — a **network call**). When `false` (default),
  uses the 4-char-per-token heuristic; deterministic, network-free,
  good to ~10-15% on English prose.

Returns:

```json
{
  "question": "what is photosynthesis?",
  "estimates": [
    {
      "tokens": 287,
      "confidence": "approximate",
      "method": "4-char-heuristic",
      "provider": "anthropic",
      "model": "claude-haiku-4-5"
    }
  ],
  "hit_count": 8,
  "per_page_byte_cap": 16384,
  "retrieval_payload_chars": 1148,
  "no_hits": false
}
```

When OpenAI/Ollama are requested with `precise: true`, the tool falls
back to the heuristic and surfaces `confidence: "approximate"` —
operators wanting exact OpenAI counts install `tiktoken` separately
(deferred to a follow-up pass to keep the daemon bundle narrow).

### `define`

Get a one-paragraph definition of an entity. BM25-search for the
entity, then return the most relevant single-paragraph definition or
page lede.

```json
{ "name": "define", "arguments": { "entity": "photosynthesis", "max_tokens": 256 } }
```

The tool looks for, in order: a `## Definition` (or `### Definition`)
section header, a `**Definition**:` inline lead-in, or the first
section whose lede starts with `<Capital> ... is/are` (encyclopaedia
opening). Falls back to the page's first paragraph.

### `relate`

Find sentences in the wiki that contain **both** `entity_a` and
`entity_b`. Intersection-based — only pages that appear in BOTH BM25
result sets get scanned for sentences.

```json
{
  "name": "relate",
  "arguments": {
    "entity_a": "Alice",
    "entity_b": "Bob",
    "max_tokens": 768,
    "max_statements": 3
  }
}
```

Returns up to `max_statements` atomic sentences, each annotated with
the source page they came from.

### `cite_sources`

Get provenance citations for a claim. BM25-search for the claim, then
return the provenance records that produced the matched wiki pages
(raw source files + chain hash + timestamp).

```json
{ "name": "cite_sources", "arguments": { "claim": "photosynthesis produces oxygen", "max_tokens": 512 } }
```

Citations include `wiki_page`, `source_files`, a truncated `chain_hash`
(16 hex chars) for cross-referencing against
`get_provenance_log`/`verify_provenance`, plus `timestamp` and record
`type`.

---

## Authentication

- **Single-token mode** (default): set `server.auth_token` in the
  config. Every request must send
  `Authorization: Bearer <that-token>`.
- **Multi-user mode**: set `multi_user.enabled: true` and use
  `wotw user add` to issue per-user tokens. Each request is
  authenticated against the on-disk token store, and the authenticated
  user name is attached to the request's provenance trail.
- **No auth**: leave `server.auth_token` null and
  `multi_user.enabled: false`. The server will accept all requests.
  Safe only on trusted localhost-only setups.

---

## Rate limiting

Every `/mcp` request is rate-limited per client IP using a token bucket
with capacity and refill rate equal to `server.rate_limit_rpm` requests
per minute. Excess requests receive HTTP `429`. When `server.trust_proxy` is `true`, the rate limiter identifies
clients by the first IP in the `X-Forwarded-For` header (use this
behind a reverse proxy). When `false` (default), it uses the TCP
socket's `remoteAddress` and ignores `X-Forwarded-For`.
