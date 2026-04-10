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
  "arguments": { "query": "hash chain", "limit": 10 }
}
```

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
    "k": 8
  }
}
```

`k` is the number of wiki pages retrieved as context (default 8, max 20).

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
  "failed_batches": 0
}
```

`orphaned_pages` counts pages whose source files were deleted (see
the deletion/archive flow in [docs/architecture.md](architecture.md#deletions)).
`failed_batches` reflects the line count of
`ingestion.dead_letter_file`; when the dead-letter queue is disabled
(empty path) this field is always `0`.

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
per minute. Excess requests receive HTTP `429`. The rate limiter
identifies clients by `X-Forwarded-For` (when behind a proxy) or by
the connection's remote address.
