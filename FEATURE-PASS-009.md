# Feature Pass 009 — Synthetic Question Generation

**Date:** 2026-05-23
**Base:** v0.7.0
**Target image:** v0.8.0
**Group:** Pass B

---

## Feature shipped

Synthetic questions emitted alongside every extracted fact at
ingestion time, indexed in parallel with the facts themselves so BM25
retrieval matches on **question shape** as well as fact content. Per
Cambridge ALTA (arXiv 2405.12363).

- **Combined LLM call.** The Pass-008 extractor returns `{ facts:
  [{ entity, statement, questions: [...] }] }` in one JSON envelope —
  no separate round trip. `questions_per_fact` in config controls how
  many synthetic questions are emitted per fact (default 3, range
  1-5).
- **`fact_questions` SQLite table.** `id`, `fact_id` (FK with ON
  DELETE CASCADE), `question_text`, `question_hash` (UNIQUE per fact).
  Duplicate questions per fact silently skip via `INSERT OR IGNORE`.
- **Two-engine fused BM25 index.** `FactIndex` runs minisearch on
  questions (weight **0.6**) alongside facts (weight **0.4**) and
  fuses per-fact scores. Question-shape wins on weight because that's
  what dominates atomic-question retrieval quality.
- **Lifecycle.** When a fact is superseded (re-ingest of its source
  page), the questions remain in the table but are filtered out by
  `listActiveQuestions` (JOIN on parent fact's `superseded_at IS
  NULL`). The in-memory `FactIndex.remove(factId, questionIds)`
  keeps the search engine in sync.

---

## Files

### Modified (no new source files — Feature 009 is a behavioural extension of FP-008)
| File | Change |
|---|---|
| `src/facts/store.ts` | `fact_questions` table + `insertQuestions` + `listActiveQuestions` + `questionHash` helper |
| `src/facts/index-manager.ts` | Two-engine search + `QUESTION_WEIGHT`/`FACT_WEIGHT` constants + fusion ranking |
| `src/facts/extractor.ts` | Prompt asks for N synthetic questions per fact; `parseFactsResponse` extracts the `questions` array |

### Configuration
| Key | Default | Range |
|---|---|---|
| `fact_extraction.questions_per_fact` | 3 | 1-5 |

### Test coverage
Embedded in the FP-008 test files:
- `test/unit/facts/store.test.ts` — duplicate-question rejection + supersession filtering
- `test/unit/facts/index-manager.test.ts` — fusion weight assertion (QUESTION_WEIGHT > FACT_WEIGHT, sum = 1), question-only match path
- `test/unit/facts/extractor.test.ts` — `parseFactsResponse` handles malformed `questions` arrays

---

## Hard gates

- ✓ Question weight > Fact weight (0.6 > 0.4) — Cambridge ALTA pattern
  preserved
- ✓ Combined extractor call (facts + questions in one round trip) —
  minimizes per-ingestion LLM cost
- ✓ ON DELETE CASCADE preserves referential integrity when a parent
  fact is deleted (in practice never — supersession marks rather than
  deletes — but the FK guards against future code paths)
- ✓ `questions_per_fact` clamped to 1-5 to prevent prompt-budget blow-up
- ✓ All 7 daemon gates green

---

## Out of scope (deferred)

- Question-only retrieval surface (e.g., a `find_questions` MCP tool)
  — `query_facts` returns facts ranked by fused score, exposing
  matched-via-question metadata; standalone question retrieval is
  a separate roadmap item.
- LLM-quality-tunable prompt for question generation (today the
  extractor's system prompt is fixed; future work could expose a
  template or per-domain prompt override).
