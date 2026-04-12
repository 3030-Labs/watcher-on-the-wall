# Retrieval Hardening

Four features that close the semantic coverage gap in watcher-on-the-wall's BM25-based retrieval system, informed by "The Price of Meaning" (arXiv 2603.27116).

## Why BM25, Not Vector Embeddings

The Price of Meaning proves that semantic retrieval systems using vector embeddings inevitably suffer from interference-driven forgetting and false recall at scale. Our BM25-based minisearch engine is immune to these failure modes — it has zero forgetting (b=0.000) and zero false recall (FA=0.000). The trade-off is a vocabulary gap: queries using different words than the stored documents will miss. These four features close that gap without introducing embedding-based interference.

## Feature 1: Query Expansion

Before hitting minisearch, the query engine expands the user's query into keyword variants via a small LLM call. The LLM returns 5–10 alternative search terms (synonyms, related technical terms, common phrasings) which are OR-combined with the original query.

- **Config:** `query.expand: true` (default on). Set to `false` for pure BM25.
- **Cost:** ~100 tokens in, ~50 tokens out. Gated by `cost.max_per_query_usd`.
- **Failure:** Falls back to original query on any LLM error or invalid response.
- **CLI mode:** Uses the CLI model at $0 cost with subscription.

## Feature 2: Richer YAML Metadata

Three new frontmatter fields on every wiki page:

- **`domain`** — Broad knowledge domain (ops, security, architecture, research, etc.)
- **`scope`** — Project or organizational context (project name, team, or "general")
- **`key_terms`** — Array of 5–15 keywords including synonyms and alternative phrasings

`key_terms` is indexed by minisearch with a 2x boost (same as tags), making pages findable by vocabulary that doesn't appear in their body text. `domain` and `scope` enable pre-filtering to narrow the search space.

### Search Filtering

Both `wotw search` and `wotw query` accept `--domain` and `--scope` flags. The MCP `search` and `query` tools accept corresponding parameters. Omitting filters searches everything (backward compatible).

## Feature 3: Knowledge Consolidation

When a topic accumulates too many pages, the health system detects this and the `wotw lint --fix` pass can merge them into one authoritative page.

- **Config:** `health.consolidation_threshold: 5`, `health.consolidation_enabled: true`
- **Detection:** Uses union-find grouping at a lower similarity threshold (40 vs 60 for dedup)
- **Heal handler:** Merges all pages in a consolidation group into one, marks originals with `status: consolidated` and `consolidated_into: <path>`
- **Difference from dedup:** Dedup merges near-identical pages. Consolidation merges topically related but distinct pages that fragment one topic area.

## Feature 4: Zero-Hit Monitoring + Vocabulary Enrichment

### Monitoring

Every query outcome is logged to `.wotw/query-log.jsonl` with timestamp, query text, and zero-hit status. The zero-hit rate is surfaced in `wotw status` and the `get_stats` MCP tool.

### Automated Enrichment

When the zero-hit rate exceeds `health.zero_hit_threshold` (default 20%), a vocabulary enrichment pass runs:

1. Read zero-hit queries from the last 7 days
2. For each query, ask the LLM which wiki pages should have matched
3. Add suggested `key_terms` to those pages' frontmatter
4. Rebuild the search index, commit, and record provenance

- **Config:** `health.zero_hit_threshold: 0.20`, `health.enrichment_enabled: true`
- **Budget:** Each query processed counts toward `max_fixes_per_run`
- **Trigger:** Runs after `wotw lint --fix` or via the daemon lint scheduler

## Closed-Loop Architecture

These features form a feedback loop:

1. **Query expansion** catches vocabulary mismatches at query time
2. **key_terms** capture vocabulary at ingestion time
3. **Consolidation** reduces topic fragmentation that dilutes BM25 scores
4. **Zero-hit monitoring** detects gaps that 1–3 missed
5. **Vocabulary enrichment** closes those gaps by adding key_terms
6. Future queries benefit from the enriched vocabulary → lower zero-hit rate
