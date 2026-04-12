# Feature Pass 004: Retrieval Hardening

**Date:** 2026-04-11
**Base:** v0.2.0 (post Codex Audit Fix Pass)
**Informed by:** "The Price of Meaning" (arXiv 2603.27116)

---

## Summary

Four retrieval-hardening features that close the semantic coverage gap in
watcher-on-the-wall's BM25-based retrieval system without introducing
embedding-based interference.

## Feature 1: Query Expansion

LLM-powered keyword variant generation before BM25 search.

- **New file:** `src/server/query-expansion.ts` — `expandQuery()` function
- **Config:** `query.expand: true` (default on)
- **Cost:** ~100 tokens in, ~50 out; gated by `cost.max_per_query_usd`
- **Fallback:** Returns original query on any LLM error or invalid response
- **Tests:** `test/unit/query-expansion.test.ts` (6 tests)

## Feature 2: Richer YAML Metadata

Three new frontmatter fields on every wiki page.

- **Fields:** `domain`, `scope`, `key_terms` (+ `consolidated_into` for Feature 3)
- **Search:** `key_terms` indexed with 2x boost (same as tags); `domain`/`scope` support pre-filtering
- **CLI:** `wotw search` and `wotw query` accept `--domain` and `--scope` flags
- **MCP:** `search` and `query` tools accept `domain` and `scope` parameters
- **Ingestion:** Prompt updated to instruct LLM to emit new fields
- **Tests:** `test/unit/metadata-search.test.ts` (7 tests)

## Feature 3: Knowledge Consolidation

Detect and merge fragmented topic clusters.

- **Detection:** Union-find grouping at similarity threshold 40 (vs 60 for dedup)
- **Config:** `health.consolidation_threshold: 5`, `health.consolidation_enabled: true`
- **Heal handler:** `healConsolidation` — merges all pages in group, marks originals `status: consolidated` with `consolidated_into: <path>`
- **New finding kind:** `consolidation` in health report
- **Tests:** `test/unit/consolidation.test.ts` (4 tests)

## Feature 4: Zero-Hit Monitoring + Vocabulary Enrichment

### Monitoring
- **New file:** `src/server/query-metrics.ts` — `recordQueryOutcome()`, `computeZeroHitRate()`
- **Query log:** JSONL at `health.query_log_file` (default `.wotw/query-log.jsonl`)
- **Surfaced in:** `wotw status`, `get_stats` MCP tool

### Automated Enrichment
- **New file:** `src/wiki/vocabulary-enricher.ts` — `runVocabularyEnrichment()`
- **Trigger:** Zero-hit rate exceeds `health.zero_hit_threshold` (default 20%)
- **Action:** LLM suggests `key_terms` additions to relevant pages
- **Budget:** Respects `health.max_fixes_per_run` cap
- **Tests:** `test/unit/query-metrics.test.ts` (9 tests)

---

## Files changed

### New source files (+3)
| File | LoC | Purpose |
|------|-----|---------|
| `src/server/query-expansion.ts` | ~126 | Query expansion via LLM |
| `src/server/query-metrics.ts` | ~75 | Query outcome logging + zero-hit rate |
| `src/wiki/vocabulary-enricher.ts` | ~150 | Automated vocabulary enrichment |

### Modified source files
| File | Changes |
|------|---------|
| `src/utils/types.ts` | Added `consolidated` status, `domain`/`scope`/`key_terms`/`consolidated_into` frontmatter, `query` config block, health config fields |
| `src/daemon/config.ts` | New defaults, Zod schema, merge logic, path resolution |
| `src/wiki/page.ts` | Parse/serialize new frontmatter fields, `consolidated` status |
| `src/wiki/search.ts` | `SearchFilters` interface, `key_terms`/`domain`/`scope` indexing, domain/scope filtering |
| `src/wiki/index.ts` | Barrel export for `SearchFilters` |
| `src/wiki/health.ts` | `consolidation` finding kind, `ConsolidationGroup`, `detectConsolidationCandidates()` |
| `src/wiki/heal-handlers.ts` | `healConsolidation` handler + dispatcher case |
| `src/server/query-engine.ts` | Query expansion step, query outcome logging |
| `src/server/tools.ts` | `domain`/`scope` params on search/query tools, `query_health` in get_stats |
| `src/cli/commands/search.ts` | `--domain` and `--scope` flags |
| `src/cli/commands/status.ts` | Query health line |
| `src/daemon/lint-scheduler.ts` | Post-lint zero-hit rate check |
| `src/ingestion/prompt-builder.ts` | New field instructions in system prompt |

### New test files (+4)
| File | Tests | Purpose |
|------|-------|---------|
| `test/unit/query-expansion.test.ts` | 6 | Query expansion LLM call, fallback, config gate |
| `test/unit/metadata-search.test.ts` | 7 | Frontmatter round-trip, search filtering, key_terms boost |
| `test/unit/consolidation.test.ts` | 4 | Consolidation detection + heal handler |
| `test/unit/query-metrics.test.ts` | 9 | Zero-hit rate computation, query logging, enrichment skip |

### Modified test files
| File | Changes |
|------|---------|
| `test/unit/query-engine.test.ts` | Disable query expansion in zero-hit guard tests |

### New documentation
| File | Purpose |
|------|---------|
| `docs/retrieval-hardening.md` | Overview of all 4 features + closed-loop architecture |

### Updated documentation
| File | Changes |
|------|---------|
| `docs/configuration.md` | `query.expand`, health consolidation/enrichment fields |
| `docs/cli-reference.md` | `--domain`/`--scope` on query + search |
| `docs/mcp-tools.md` | domain/scope params, query_health in get_stats, trust_proxy note |
| `docs/knowledge-health.md` | Consolidation finding/handler, vocabulary enrichment section |
| `docs/provenance.md` | `consolidation` and `vocabulary-enrichment` heal_kind values |

---

## Config changes

```yaml
# New top-level block
query:
  expand: true                    # LLM-powered query expansion before BM25

# New health fields
health:
  consolidation_threshold: 5     # merge when topic has > N pages
  consolidation_enabled: true    # master switch
  zero_hit_threshold: 0.20       # trigger enrichment at 20% zero-hit rate
  enrichment_enabled: true       # master switch
  query_log_file: .wotw/query-log.jsonl
```

---

## Gate results

| Gate | Result |
|------|--------|
| `pnpm typecheck` | Clean |
| `pnpm lint` | Clean |
| `pnpm format:check` | Clean |
| `pnpm test` | **386 passed** / 42 files |
| `pnpm build` | Success (~289 KB CLI bundle) |

## Headline numbers

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Source files | 72 | 75 | +3 |
| Test files | 38 | 42 | +4 |
| Tests | 359 | 386 | +27 |
| Source LoC | ~11,950 | ~12,800 | +850 |
| Test LoC | ~5,900 | ~6,770 | +870 |
| CLI bundle | ~273 KB | ~289 KB | +16 KB |
