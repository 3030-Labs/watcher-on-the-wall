# Feature Pass 008 — Fact-Level Retrieval Layer

**Date:** 2026-05-23
**Base:** v0.7.0 (post Pass A context-efficiency layer; commit `4acd79e` + G5 scaffolding at `1875925`)
**Target image:** v0.8.0
**Group:** Pass B (Foundational context-efficiency layer)

---

## Feature shipped

A SQLite-backed fact store + minisearch fact index + LLM extractor that
decomposes each ingested wiki page into atomic `(entity, statement)`
facts. Per Yanhong Li / TTIC factual decomposition (arXiv 2503.19574),
this delivers atomic-question retrieval at ~10× the token efficiency
of page-level retrieval.

- **`src/facts/store.ts`** — SQLite schema + CRUD + supersession.
  `facts` table (id, wiki_page_id, entity, statement, fact_hash,
  created_at, superseded_at), CREATE TABLE IF NOT EXISTS pattern,
  PRAGMA user_version=1 migration. Refuses to open chains at higher
  schema versions.
- **`src/facts/index-manager.ts`** — Two-engine minisearch (facts on
  entity+statement, weight 0.4; questions on question_text, weight
  0.6). Fused on per-fact basis with weighted sum.
- **`src/facts/extractor.ts`** — Single combined LLM call returning
  facts + N synthetic questions per fact in one JSON envelope.
  Cost-free detection (Ollama / Claude Code CLI auto-active;
  Anthropic/OpenAI/Gemini opt-in via `force_enabled`).
- **`isExtractionActive(config, runtimeMode)`** — deterministic
  classifier surfaced in the daemon startup banner so operators can
  see at a glance whether the layer is on or off and why.

The ingestion queue (`src/ingestion/queue.ts`) hooks fact extraction
after each successful page write as a best-effort sidecar: extraction
failure does NOT fail the surrounding ingestion. Facts land in the
SQLite store via `supersedeByWikiPage` (handle re-ingest) +
`insertFact` + `insertQuestions`; the in-memory `FactIndex` is updated
in lock-step.

---

## Files

### New source files
| File | Purpose |
|---|---|
| `src/facts/types.ts` | `Fact`, `FactQuestion`, `FactWithQuestions` interfaces |
| `src/facts/store.ts` | SQLite-backed FactStore (better-sqlite3, WAL mode) |
| `src/facts/index-manager.ts` | Minisearch BM25 over facts + questions, weighted fusion |
| `src/facts/extractor.ts` | LLM extractor + `isExtractionActive` + `parseFactsResponse` |

### Modified
| File | Change |
|---|---|
| `src/utils/types.ts` | `OperationType` extended with `"fact_extraction"` + `"fact_extracted"`; `WotwConfig.fact_extraction` block; `ProvenanceRecord.fact_hashes_added` + `fact_hashes_superseded` (optional) |
| `src/daemon/config.ts` | Default `fact_extraction` block + Zod schema + mergeConfig hookup |
| `src/provenance/chain.ts` | `ProvenanceAppendInput` accepts `fact_hashes_added` / `fact_hashes_superseded`; record builder writes them (NOT folded into canonical payload, so forward/backward compat preserved) |
| `src/ingestion/queue.ts` | Post-write fact-extraction sidecar (`runFactExtraction`) |
| `src/daemon/entry.ts` | Instantiates `FactStore` + `FactIndex`, loads from disk, logs status |

### New deps
- `better-sqlite3` (runtime, MIT, ~2 MB after build) — synchronous SQLite
- `@types/better-sqlite3` (dev)
- `pnpm.onlyBuiltDependencies: ["better-sqlite3"]` — explicit
  approval for the native build script

### New tests
| File | Tests |
|---|---|
| `test/unit/facts/store.test.ts` | 12 — schema + migration + CRUD + supersession + hash helpers |
| `test/unit/facts/index-manager.test.ts` | 7 — rebuild + search + fusion weights + add/remove |
| `test/unit/facts/extractor.test.ts` | 13 — gating + JSON parsing + mocked LLM |
| `test/unit/provenance-fact-extracted.test.ts` | 4 — forward/backward compat + canonical payload invariance |

---

## Hard gates

- ✓ Backwards compatible (existing `query` / `search` unchanged; missing
  facts.db boots cleanly)
- ✓ ProvenanceRecord schema extension forward/backward compat — new
  fields not in canonical payload, so id + chain_hash + hmac stay
  identical to a record without them; old daemons reading new chains
  ignore the new fields during verification
- ✓ Pass 008 BYOK preserved (extractor goes through runtimeAwareComplete)
- ✓ BM25-only commitment preserved (FactIndex uses minisearch; no
  vector code paths introduced)
- ✓ Cost-free auto-detection deterministic: `ollama→true`, `cli→true`,
  `api→force_enabled-controlled`
- ✓ All 7 daemon gates green

---

## Stop conditions evaluated

| condition | status |
|---|---|
| Schema migration fails compat test | did not fire (idempotent CREATE IF NOT EXISTS; tested across reopens; refuses to downgrade) |
| Runtime auto-detection misclassifies | did not fire (tests cover all 4 provider × 2 runtime combinations) |
| Ingestion cost increase >50% on api-mode | n/a (extraction is OFF by default on api-mode; explicit opt-in via `force_enabled`) |

---

## Out of scope (deferred)

- Live-API extraction quality measurement across all 4 providers (see
  CONTEXT-EFFICIENCY-PASS-B.md §"Per-provider quality" — deferred per
  Phase-A pattern of irreducibly-external validation)
- HMAC attestation of `fact_hashes_added` / `fact_hashes_superseded` —
  today these are metadata, not folded into the canonical payload
  (intentional, to preserve forward/backward compat); attestation
  would require a separate field outside the canonical-id boundary
