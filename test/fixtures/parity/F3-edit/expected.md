# F3 — Edit-existing-page — expected single-pass output

**Dimension (Phase A):** edit-existing-page — a topic is ingested, then a SECOND
source on the SAME entity is ingested in a later batch. This exercises the
update / supersede path (candidates-gated mutation), distinct from fresh
ingestion.

**Parity criterion (shipped single-pass providers):** the second batch must
UPDATE the existing Python page (or supersede it), NOT silently create a
duplicate isolated page and NOT crash. Provenance must record both batches.

## Sequence
1. Batch 1: `python-language.md` (Guido van Rossum, 1991, Python 2 vs 3, CPython).
2. Batch 2: `python-language-update.md` (Python 2 EOL 2020; 3.11 speedups;
   Steering Council replaced BDFL; data-science adoption).

## Expected structural properties
- After batch 1: a Python page exists with the initial facts.
- After batch 2: the Python material reflects the NEW facts (Python 2 EOL,
  Steering Council, 3.11) — either by updating the existing page in place or by
  superseding it (frontmatter `superseded_by` / `updated` timestamp advancing).
- Provenance chain contains records for BOTH batches (>= 2 ingest/edit records).
- The total Python-entity page count does not balloon into duplicates: the
  second batch should converge on the existing entity, not fork it.
- Zero dead-letter entries.

## Expected concept coverage after both batches
- Python (entity): created by Guido van Rossum, 1991, significant indentation.
- Python 2 end-of-life (2020) — the updated fact must be present.
- Steering Council / BDFL transition (2018 step-down).
- CPython reference implementation.

## Parity break (STOP) would be
- Batch 2 creates a second, unrelated Python page with no link/supersede to the
  first (duplicate-fork instead of update).
- Provenance missing a record for either batch.
- The update batch crashes or dead-letters.

## Model-sensitivity finding (Phase 2, 2026-05-31)
The edit-existing-page MERGE is model-tier-sensitive — run this fixture at the
default `cli_model` tier (`claude-sonnet-4-5`), NOT `claude-haiku-4-5`:
- **`claude-haiku-4-5`:** batch 2 ingested (provenance + `sources/` mirror) but
  emitted NO concept-page edit. The new facts (Python 2 EOL, Steering Council,
  3.11) stayed stranded in `sources/python-language-update.md`; the existing
  concept page was not updated. Wiring is correct (queue.ts:289 populates the
  existing-pages manifest; prompt-builder surfaces it with "prefer updating") —
  haiku simply did not act on it in a single pass.
- **`claude-sonnet-4-5` (default):** batch 2 UPDATED `python.md` in place
  (`last_compiled` advanced to batch-2 time, `sources:` gained the update file,
  body gained the EOL/3.11/BDFL facts) and added a `python-steering-council`
  entity page. No duplicate fork. PASS.

Why it matters: baseline (pre-refactor) used the multi-turn Agent SDK, which
could iteratively read + edit existing files. Single-pass hands the model one
shot with a slim manifest, so the edit-existing path is more model-capability-
dependent than fresh ingestion (F2/F5 passed even on haiku). This is the
boundary P3's per-provider precision/recall + accepted-delta policy must
characterize, and a reason CI cassettes should be recorded at the default tier.
