# Architecture

`wotw` is a long-running Node.js daemon with several loosely-coupled
subsystems. Each subsystem implements a `DaemonSubsystem` interface
(`name`, `start()`, `stop()`) and is lifecycle-managed by the root daemon.

---

## Subsystems

| Subsystem | File | Responsibility |
|----|----|----|
| `watcher` | `src/watcher/index.ts` | Watches `raw_path` with chokidar, debounces bursts, emits batches (including `deletedPaths`) |
| `ingestion` | `src/ingestion/queue.ts` | Runs a Claude agent over each batch, validates output, commits to git, appends provenance; on deletion batches, archives rather than deletes |
| `mcp-server` | `src/server/index.ts` | HTTP server exposing MCP tools over stateless streamable transport |
| `compounding` | `src/compounding/engine.ts` | Periodic background pass that finds tag clusters and synthesizes meta-pages |
| `lint-scheduler` | `src/daemon/lint-scheduler.ts` | Optional periodic background lint pass (same sweep as `wotw lint`) |
| `wiki` | `src/wiki/` | Store, search index, index.md manager, cross-reference repair |
| `provenance` | `src/provenance/chain.ts` | Append-only SHA-256 hash chain of every state mutation |
| `cost` | `src/ingestion/cost-tracker.ts` | Daily/per-op budget enforcement |
| `dead-letter` | `src/ingestion/dead-letter.ts` | Append-only JSONL ledger of permanently-failed ingestion batches |
| `multi-user` | `src/multi-user/token-store.ts` | Optional bearer-token auth for the MCP server |

Everything runs in a single process. The CLI spawns a detached child
process with `child_process.spawn` (`detached: true`, `stdio: 'ignore'`)
and exits immediately. The child detects `WOTW_DAEMON_CHILD=1` in its
environment and hands control to `src/daemon/entry.ts`, which constructs
all subsystems and starts them. `spawn` (not `fork`) is required because
`fork`'s implicit IPC channel keeps the parent alive on WSL/Windows —
see decision D-16.

---

## Data flow

1. **Raw input.** A user (or an agent) drops a markdown file into
   `wiki_root/raw/`.
2. **Watcher.** Chokidar fires; the watcher enqueues the file and starts
   a debounce timer. If more files land before the timer fires, the timer
   is reset with exponential backoff (`debounce_initial_ms` ×
   `debounce_growth_factor`, capped at `debounce_max_ms`). When the
   timer fires, the batch is emitted.
3. **Ingestion.** The pipeline creates a Claude agent session scoped to
   the `raw/` and `wiki/` directories, hands it the batch, and lets it
   write wiki pages directly. On agent completion, the pipeline:
   1. Reconciles the paths the agent reported (paths outside the wiki dir
      are dropped).
   2. Repairs bidirectional `related:` links across the whole wiki.
   3. Rebuilds the index.md sentinel block.
   4. Rebuilds (or upserts into) the search index.
   5. Commits the changes to git with a structured message.
   6. Appends a provenance record committing to the batch's inputs,
      prompt hash, model, response hash, and written file hashes.
4. **Serving.** The MCP server streams tool calls from any connected
   client. `search`, `list_pages`, and `read_page` are pure reads.
   `query` runs a second Claude agent that receives the top-k search
   results as context. `synthesize` triggers a compounding pass.

### Deletions

When a raw file is deleted, the watcher surfaces the event as
`batch.deletedPaths`. The ingestion queue treats deletions as a
strictly non-LLM path:

1. For each deleted source, walk the provenance chain looking for
   `ingest` records that listed it in `source_files`.
2. For every affected wiki page, rewrite the frontmatter to set
   `status: orphaned`, `orphaned_at: <ISO-8601>`, and
   `orphaned_source: <deleted path>`. **The page body and the file
   on disk are left untouched** — we never delete wiki pages in
   response to source deletions.
3. Append an `archive` provenance record (`type: "archive"`,
   `source_hashes: ["deleted"]`, `model_id: "none"`) committing to
   the rewritten page hashes.
4. Rebuild the search index and `index.md` sentinel block.

`wotw lint` surfaces the orphan count, and the `get_stats` MCP tool
exposes `orphaned_pages` so a dashboard can track it. See
[docs/provenance.md](provenance.md#archive-records) for the record
format.

Mixed batches (some adds, some deletes) run the add path first and
the archive path second in a single queue tick, so the provenance
chain reflects the exact ordering.

### Dead-letter queue

Ingestion failures that survive the pipeline's internal retries
(budget exhaustion, agent crash, wiki write error, etc.) do not
crash the daemon. The queue catches the error, appends a single JSON
line to `ingestion.dead_letter_file`, logs an ERROR, and continues
with the next batch. Each record contains:

```json
{
  "timestamp": "2026-04-07T15:30:00.000Z",
  "batch_id": "batch-abc123",
  "files": ["/abs/raw/a.md", "/abs/raw/b.md"],
  "reason": "add",
  "mode": "api",
  "error": "budget exceeded",
  "stack": "…",
  "retry": false
}
```

An empty string in `dead_letter_file` disables the queue entirely
(every `record()` call becomes a no-op), which is the convention
used by tests and minimal deployments. `wotw status` and the
`get_stats` MCP tool both surface a count so operators can monitor
without tailing the log.

### Periodic lint

When `lint.schedule_enabled: true`, the `LintScheduler` subsystem
runs the same sweep as `wotw lint` on a timer (`interval_hours`, via
`setInterval().unref()`). Clean sweeps log INFO, sweeps with issues
log WARN. The timer is `unref`'d so it never keeps the daemon alive
on its own — the daemon's own check-interval is the keep-alive.
Disable with `schedule_enabled: false` (the default) to make the
scheduler a cheap no-op.

---

## Wiki structure

```
wiki-store/
  raw/              # user-dropped source files
  wiki/
    index.md        # auto-generated, sentinel-delimited
    concepts/       # one page per concept
    entities/       # one page per entity (person, org, tool)
    sources/        # one page per primary source / reference
    comparisons/    # side-by-side comparison pages
    syntheses/      # compounded higher-level pages
    queries/        # auto-recorded query interactions
  provenance-chain.jsonl
  cost-log.jsonl
  .git/
```

Each page is YAML-frontmatter markdown:

```markdown
---
title: Hash Chains
category: concept
tags: [crypto, integrity]
sources: [raw/notes.md]
related: [concepts/merkle-trees]
confidence: 85
created: 2026-04-01T12:00:00.000Z
updated: 2026-04-01T12:00:00.000Z
---
A hash chain is a sequence of records where each commits to the previous
via SHA-256...
```

Links between pages use the `related:` frontmatter field and (optionally)
`[[wiki-link]]` syntax in the body. The cross-reference repairer
guarantees that if page A lists page B as related, page B lists A too.

---

## Provenance

Every mutation appends a record to `provenance-chain.jsonl` of the form:

```json
{
  "seq": 42,
  "id": "sha256 of canonical payload",
  "timestamp": "2026-04-01T12:00:00.000Z",
  "type": "ingest",
  "source_files": ["raw/notes.md"],
  "source_hashes": ["…"],
  "prompt_hash": "…",
  "model_id": "claude-haiku-4-5",
  "response_hash": "…",
  "wiki_files_written": ["wiki/concepts/hash-chains.md"],
  "wiki_file_hashes_after": { "wiki/concepts/hash-chains.md": "…" },
  "previous_id": "…",
  "previous_chain_hash": "…",
  "chain_hash": "sha256(previous_chain_hash || id)",
  "metadata": { "cost_usd": 0.012 }
}
```

- **`id`** is the SHA-256 of the canonicalized record payload (all keys
  sorted recursively). This makes the id content-addressable and
  independent of insertion order.
- **`chain_hash`** folds the previous chain hash into the current id so
  the whole file is tamper-evident — flip any byte in any record and
  every subsequent `chain_hash` fails to match.
- **`wotw audit`** walks the chain end-to-end, recomputing every id and
  chain hash, and reports the first divergence.

See [docs/provenance.md](provenance.md) for the full format.

---

## Compounding

When the wiki has ≥ `compounding.min_source_pages` pages (default 3),
the compounding scheduler runs periodically. It:

1. Groups pages by tag and picks tags with enough members.
2. Skips any cluster that already has a synthesis page (idempotent).
3. For each remaining cluster, invokes a second Claude agent with the
   full text of every member, asks it to write a synthesis page, and
   commits the result.
4. Appends a provenance record of `type: "compound"`.

Compounding is budget-gated: if today's spend exceeds
`cost.max_daily_usd`, the pass skips.

---

## Process model

- **One daemon = one wiki.** If you want multiple wikis, run multiple
  daemons on different ports.
- **Single writer.** Git, the wiki store, and the provenance chain are
  all serialized through a single writer path. Reads are lock-free.
- **Detached child.** The CLI `wotw start` spawns a detached daemon
  child with `child_process.spawn` (`detached: true`, `stdio: 'ignore'`)
  and exits immediately; all daemon state lives in the child. `fork` is
  intentionally not used — see decision D-16.
- **Crash-safe.** Every write is atomic (temp file + rename); every
  append to the provenance chain is fsync'd before returning.
