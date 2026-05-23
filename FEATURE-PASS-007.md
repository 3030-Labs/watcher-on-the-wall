# Feature Pass 007 — Structural Narrow-Query MCP Tools

**Date:** 2026-05-23
**Base:** v0.6.0 (post Layer-1 remediation; commit `b421024`)
**Target image:** v0.7.0
**Group:** Pass A (Context Efficiency)

---

## Features shipped

Three additive MCP tools that expose targeted retrieval primitives at
deliberately small token caps. Each runs a single BM25 retrieval and
renders a payload that fits inside its budget — no daemon-side LLM
call.

- **`define(entity, max_tokens?)`** — single-paragraph definition.
  256-token cap by default.
- **`relate(entity_a, entity_b, max_tokens?, max_statements?)`** — up
  to 3 atomic relationship statements between two anchors.
  Intersection-based: only pages in BOTH BM25 result sets are scanned.
  768-token cap by default.
- **`cite_sources(claim, max_tokens?)`** — provenance citations for a
  claim. BM25-search the claim, look up provenance records for the top
  matches, return wiki_page + source_files + chain_hash references.
  512-token cap by default.

Reference: Codebase-Memory (arXiv 2603.27277) demonstrates 83% answer
quality at 10× token reduction using structural narrow queries vs
file-exploration agents.

---

## Files

### New source files
| File | Purpose |
|---|---|
| `src/server/narrow-query.ts` | All three handler implementations + definition picker (Definition section / `**Definition**:` lead-in / "X is..." encyclopaedia opening) |

### Modified
| File | Change |
|---|---|
| `src/server/tools.ts` | Register `define`, `relate`, `cite_sources` |

### New tests
| File | Tests | Coverage |
|---|---|---|
| `test/unit/mcp/define.test.ts` | 5 | happy path, empty corpus, budget enforcement, malformed input, BM25-only regression |
| `test/unit/mcp/relate.test.ts` | 4 | happy path, empty intersection, budget enforcement, malformed input |
| `test/unit/mcp/cite-sources.test.ts` | 5 | happy path, provenance disabled, empty corpus, budget enforcement, malformed input |

---

## Design notes

### `define` — definition picker

The picker tries three strategies in order:

1. **Explicit Definition section.** Looks for `## Definition` / `###
   Definition` (case-insensitive) at any heading level 1-6. If found,
   the first paragraph after that header is returned.
2. **Inline `**Definition**:` lead-in.** The Markdown convention
   `**Definition**: ...` appears on a single line — captured and
   returned.
3. **Encyclopaedia opening.** `extractSectionLedes` is scanned for a
   section whose lede starts with `<Capital> ... is/are` (the canonical
   Wikipedia opening). Returns the first matching lede.

If none match, falls back to the page's first paragraph, then the BM25
snippet as a last resort. The result is then truncated to the supplied
token cap via the shared `truncateToTokenBudget` (sentence-boundary
preferred).

### `relate` — intersection-based ranking

Two BM25 searches (one per anchor, k=10 each). Pages that appear in
BOTH result sets become candidates; their combined score (sum) ranks
them. For each candidate page we crack open the body, run
`extractSentencesContainingAll([entity_a, entity_b])`, and collect up
to `max_statements` sentences from the highest-scoring candidates,
stopping when the cumulative token count would exceed `max_tokens`.

The intersection requirement is what gives `relate` its precision —
returning sentences from pages that only mention one anchor would be
worse than `search` is today.

### `cite_sources` — provenance lookup

BM25-search for the claim (k=5). For each matched page, call
`provenance.recordsFor(relativePath)` — this returns every record
whose `wiki_files_written` includes the page (the post-Layer-1 daemon
stores wiki-relative paths in that field). The **most recent** record
is used so the citation reflects the page's current provenance.

Returns: `wiki_page`, `score`, `title`, `source_files`, `chain_hash`
(truncated to 16 hex chars for client readability), `timestamp`,
`type`. JSON-serialized and budget-capped.

When the daemon's provenance subsystem is disabled
(`config.provenance.enabled = false`), the tool returns
`provenance_unavailable: true` immediately — no BM25 search wasted.

---

## Hard gates

- ✓ Backwards compatible (no existing tool touched)
- ✓ BM25-only commitment preserved (single regression guard test
  covers all three handlers via `narrow-query.ts` source scan)
- ✓ Pass 008 BYOK invariants preserved (no LLM call → no key touched)
- ✓ AGPL boundary preserved (no wotw-cloud imports)
- ✓ All 7 daemon gates green
- ✓ Token caps enforced (tested at the handler level)

---

## Out of scope (deferred to Group B)

- Atomic-fact decomposition at ingest time. With pre-computed facts,
  `define`/`relate`/`cite_sources` could match against fact-level
  candidates instead of running per-call BM25 over the page corpus.
  See `CONTEXT-EFFICIENCY-PASS-A.md` Group B sequencing.
- `cite_sources` quoting evidence text from the source file, not just
  filename. Would require resolving the raw path at query time and is
  fail-loud-prone (raw file may be deleted; provenance still has the
  hash).
- `relate` returning the BM25 score for each statement individually
  (currently the per-page combined score is surfaced).
