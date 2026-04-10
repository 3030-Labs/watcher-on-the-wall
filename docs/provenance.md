# Provenance chain

`wotw` records every state-mutating operation as an append-only,
cryptographically-chained JSONL record. The chain lives at
`{wiki_root}/provenance-chain.jsonl` by default and is designed so
that:

1. The id of every record is content-addressable (independent of
   insertion order).
2. Any byte-level tampering of any past record invalidates every
   subsequent record's `chain_hash`.
3. The format is grep-friendly and easy to audit with non-`wotw`
   tools.

---

## Record schema

Each line is a single JSON object:

```json
{
  "seq": 1,
  "id": "3ac959749f79…",
  "timestamp": "2026-04-01T12:00:00.000Z",
  "type": "ingest",
  "source_files": ["raw/notes.md"],
  "source_hashes": ["a1b2…"],
  "prompt_hash": "c3d4…",
  "model_id": "claude-haiku-4-5",
  "response_hash": "e5f6…",
  "wiki_files_written": ["wiki/concepts/hash-chains.md"],
  "wiki_file_hashes_after": { "wiki/concepts/hash-chains.md": "f7a8…" },
  "previous_id": null,
  "previous_chain_hash": "0000000000000000000000000000000000000000000000000000000000000000",
  "chain_hash": "9bca…",
  "metadata": { "cost_usd": 0.012, "user": "alice" }
}
```

| Field | Type | Notes |
|----|----|----|
| `seq` | number | Monotonic, starts at 1 |
| `id` | string | `sha256(canonical(payload))` — see below |
| `timestamp` | ISO-8601 string | UTC |
| `type` | `"ingest" \| "query" \| "compound" \| "archive"` | Operation type — `compound` is emitted by the compounding synthesis engine; `archive` is emitted when a raw source is deleted and its dependent wiki pages are marked orphaned (see "Archive records" below) |
| `source_files` | `string[]` | Wiki-relative paths |
| `source_hashes` | `string[]` | `sha256` of each source file, same order |
| `prompt_hash` | string | `sha256` of the exact system+user prompt bytes |
| `model_id` | string | e.g. `claude-haiku-4-5` |
| `response_hash` | string | `sha256` of the raw agent response |
| `wiki_files_written` | `string[]` | Wiki-relative paths written during this op |
| `wiki_file_hashes_after` | `Record<string,string>` | `sha256` of each written file **after** the write |
| `previous_id` | `string \| null` | `id` of the previous record (or `null` for seq 1) |
| `previous_chain_hash` | string | `chain_hash` of the previous record (or `GENESIS_HASH` for seq 1) |
| `chain_hash` | string | `sha256(previous_chain_hash \|\| id)` |
| `metadata` | object | Free-form — typically includes `cost_usd`, `user`, `session_id` |

`GENESIS_HASH` is `"0".repeat(64)`.

---

## Canonical hashing

The record's `id` is computed over a canonicalized JSON payload:

1. Take every field **except** `id` and `chain_hash`.
2. Recursively sort every object's keys.
3. Serialize with `JSON.stringify` (no whitespace).
4. `sha256` the UTF-8 bytes of that serialization.

This makes `id` independent of the insertion order of fields, so two
processes building the same record on different machines will agree.

---

## Chain hashing

For each record:

```
chain_hash = sha256(previous_chain_hash || id)
```

where `||` is string concatenation. The first record uses
`GENESIS_HASH` as `previous_chain_hash`.

Any mutation of any past record changes its `id`, which changes its
`chain_hash`, which breaks the `previous_chain_hash` of the next
record, and so on.

---

## Verification

`wotw audit` (or the `verify_provenance` MCP tool) walks the chain
record-by-record. For each record it:

1. Recomputes the canonical `id` and compares to the stored `id`.
2. Recomputes `chain_hash` from `previous_chain_hash` + `id` and
   compares to the stored `chain_hash`.
3. Compares `previous_chain_hash` against the walker's running
   previous chain hash.

Any mismatch stops the walk and reports the first failing seq.

---

## What a signature proves

When every record in the chain verifies, you can prove:

- **Exactly which files** were inputs to each operation (`source_hashes`).
- **Exactly which prompt** was sent to the model (`prompt_hash`).
- **Exactly which model** answered (`model_id`).
- **Exactly which response** the model produced (`response_hash`).
- **Exactly what the wiki looked like after** the write
  (`wiki_file_hashes_after`).
- The **chronological order** of every operation.
- The **monetary cost** of each operation (`metadata.cost_usd`).
- In multi-user mode, the **authenticated user** responsible
  (`metadata.user`).

---

## Archive records

When a raw source file is deleted (`unlink` event from the watcher),
`wotw` does **not** delete the wiki pages that were written from it.
Instead the ingestion pipeline:

1. Walks the provenance chain to find every `wiki_files_written` path
   whose `source_files` included the deleted raw path.
2. Rewrites the frontmatter of each affected page to set
   `status: orphaned`, `orphaned_at: <ISO-8601>`, and
   `orphaned_source: <the deleted raw path>`. The page body is
   untouched.
3. Appends an `archive` record to the provenance chain committing to
   the orphaned pages' new hashes.

An archive record looks like:

```json
{
  "seq": 43,
  "id": "…",
  "timestamp": "2026-04-07T15:30:00.000Z",
  "type": "archive",
  "source_files": ["raw/notes.md"],
  "source_hashes": ["deleted"],
  "prompt_hash": "…",
  "model_id": "none",
  "response_hash": "…",
  "wiki_files_written": [
    "wiki/concepts/hash-chains.md",
    "wiki/concepts/merkle-trees.md"
  ],
  "wiki_file_hashes_after": { "…": "…" },
  "previous_id": "…",
  "previous_chain_hash": "…",
  "chain_hash": "…",
  "metadata": {
    "orphaned_pages": 2,
    "orphaned_source": "raw/notes.md"
  }
}
```

A few specifics:

- **`source_hashes: ["deleted"]`** is a sentinel. The source file is
  gone, so we can't hash it — and we deliberately don't want to trust
  a cached hash. The sentinel makes the intent explicit in the ledger.
- **`model_id: "none"`** because no LLM is invoked on the archive
  path. Archive is a pure bookkeeping operation.
- **The chain still verifies.** Archive records are canonical JSON
  like every other record; `wotw audit` walks them and folds them
  into the chain hash normally.
- **Wiki files are never deleted.** Even if every source that
  produced a page is deleted, the page stays on disk with
  `status: orphaned` so the user can decide whether to keep it as
  historical context, merge it into another page, or remove it by
  hand. `wotw lint` reports the orphan count so orphans don't sit
  forgotten.
- **Idempotent on repeat.** Deleting the same source twice produces
  two archive records (the second will have an empty
  `wiki_files_written` because no pages need their frontmatter
  touched again) so the chain reflects that the operator tried
  twice.

This design means the provenance chain is a complete record of every
intended state transition — including the intent to "forget" a
source — without ever actually losing history.

---

## Rotation

The chain file is append-only and grows forever. Rotation is manual:
`wotw audit --full` first to verify integrity, then archive the
current chain and start a new one whose seq-1 record's
`previous_chain_hash` equals the archived chain's final `chain_hash`.

A `wotw provenance rotate` command is not yet implemented.
