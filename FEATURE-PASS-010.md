# Feature Pass 010 — Fact Lifecycle + Provenance

**Date:** 2026-05-23
**Base:** v0.7.0
**Target image:** v0.8.0
**Group:** Pass B

---

## Feature shipped

Fact lifecycle management (creation, supersession, provenance audit
trail) bolted onto the Pass-008 store + Pass-009 questions. The wiki
remains the source of truth — facts are derived, supersession is
mechanical, and the provenance chain records the lineage.

- **`fact_extracted` ProvenanceRecord type.** Every successful
  extraction appends a `type: "fact_extracted"` record to the
  cryptographic provenance chain, carrying `fact_hashes_added` +
  `fact_hashes_superseded` arrays.
- **Cost tracking.** Extraction costs are metered under the new
  `operation_type: "fact_extraction"` in `cost-tracker.ts`, so
  daily/per-operation caps gate the layer the same as ingest/query.
- **Supersession on re-ingest.** When a page is re-ingested,
  `FactStore.supersedeByWikiPage(relPath)` marks every active fact
  for that page as superseded (sets `superseded_at`), and the new
  extraction round inserts fresh rows. The lineage is queryable via
  `listByWikiPage(relPath)` (returns active + superseded ordered by
  `created_at`).
- **Heal + compounding.** *(Deferred — see Out of scope.)*

---

## Provenance record shape

```json
{
  "type": "fact_extracted",
  "seq": 42,
  "timestamp": "2026-05-23T12:00:00.000Z",
  "source_files": ["wiki/concepts/photosynthesis.md"],
  "source_hashes": ["<sha256 of page body>"],
  "prompt_hash": "<sha256 of llm prompt prefix>",
  "model_id": "claude-sonnet-4-5",
  "response_hash": "<sha256 of llm response>",
  "wiki_files_written": [],
  "wiki_file_hashes_after": {},
  "previous_id": "<prior record id>",
  "previous_chain_hash": "<prior chain hash>",
  "chain_hash": "<this record's chain hash>",
  "id": "<canonical id>",
  "fact_hashes_added": ["<fact_hash 1>", "<fact_hash 2>"],
  "fact_hashes_superseded": ["<fact_hash 3>"],
  "metadata": {
    "batch_id": "<ingestion batch id>",
    "facts_added": 2,
    "facts_superseded": 1,
    "cost_usd": 0.0012,
    "duration_ms": 850
  }
}
```

`fact_hashes_added` and `fact_hashes_superseded` are **stored on the
record** but **NOT folded into the canonical payload**. This is
deliberate: an old daemon reading a chain that contains them computes
the canonical id over the same fields it would for an older record,
and the verification passes. The fields are best-effort metadata for
auditing the fact lineage, not cryptographically attested.

A `verify_provenance` walk over a chain containing `fact_extracted`
records returns the same `ok: true` result it would for a chain
without them — verified end-to-end in
`test/unit/provenance-fact-extracted.test.ts`.

---

## Files

### Modified
| File | Change |
|---|---|
| `src/utils/types.ts` | `OperationType` extended; `ProvenanceRecord.fact_hashes_added` + `fact_hashes_superseded` optional fields |
| `src/provenance/chain.ts` | `ProvenanceAppendInput` accepts the new fields; record builder writes them outside the canonical-payload computation |
| `src/ingestion/cost-tracker.ts` | New `"fact_extraction"` operation type (via the `OperationType` extension; the tracker is already op-type-agnostic) |
| `src/ingestion/queue.ts` | `runFactExtraction` sidecar emits the provenance record after each page's extraction completes |

### Test coverage
- `test/unit/provenance-fact-extracted.test.ts` — 4 tests covering
  backward compat, forward compat (canonical payload invariance), the
  no-empty-arrays-leak path, and round-tripping a `fact_extracted`
  record through `readRecent`.

---

## Hard gates

- ✓ Provenance chain forward/backward compatibility verified
- ✓ `verify_provenance` returns `ok: true` for chains containing
  `fact_extracted` records
- ✓ Cost tracking metered under `"fact_extraction"` so daily caps still
  fire when extraction is opted into on metered providers
- ✓ Best-effort: extraction failure does NOT fail the surrounding
  ingestion (tested in `test/unit/facts/extractor.test.ts` via the
  `ran=false` skip path)
- ✓ All 7 daemon gates green

---

## Out of scope (deferred)

- **Heal + compounding fact regeneration.** When `wotw lint --fix`
  rewrites a wiki page, today the existing facts for that page stay
  active. A future pass should mark them superseded and run fresh
  extraction. The current code path is documented but not wired —
  the FactStore's `supersedeByWikiPage` is ready, the hook into
  `src/wiki/heal-handlers.ts` is the next step.
- **HMAC attestation of `fact_hashes_*`.** As above, the fields are
  metadata. Attesting them would require either (a) a chain-version
  bump that folds them into the canonical payload (breaks backward
  compat) or (b) a separate HMAC over the metadata (adds verification
  complexity). Deferred until the field gets adversarial-attack
  visibility.
