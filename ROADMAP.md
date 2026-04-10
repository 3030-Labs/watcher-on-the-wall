# Roadmap

`wotw` is versioned loosely — features land when they're ready, not on
a calendar. This doc tracks what's done, what's in-flight, and what
we've explicitly decided not to build yet. Items move between buckets
frequently; the git history of this file is the source of truth.

---

## ✅ Shipped (0.1.0)

- Dual-mode runtime (`cli` / `api` / `auto`)
- Adaptive debounce batcher with burst flush
- Ingestion pipeline with budget gating and cost tracking
- SHA-256 provenance chain with forward-folding chain hash
- `wotw audit` + `verify_provenance` MCP tool
- Full-text search (minisearch) with title/tag boost
- MCP server (stateless streamable HTTP) with 10 tools
- Compounding synthesis engine
- Multi-user token store
- Cryptographic path containment in MCP tools (M-SEC-1)
- No-auth safety rail: refuse non-loopback bind without auth (M-SEC-2)
- Eager provenance hashing (M-PIPE-1)
- `wotw init` / `start` / `stop` / `status` / `query` / `lint` /
  `synthesize` / `audit` / `serve` / `user` / `logs`
- **Feature-pass 001 (0.1.x):**
  - Periodic background lint scheduler
  - Deletion handling via `"archive"` provenance records (never
    deletes wiki files — marks them `status: orphaned`)
  - `wotw logs` command (tail + follow) + startup banner
  - Dead-letter queue for permanently-failed batches

---

## 🚧 In flight (targeting 0.2)

- **Query cache.** Cache query results keyed by
  `(question, top_k_page_hashes, model_id)` so re-asking the same
  question against an unchanged wiki is free. Must invalidate on any
  provenance append that touches a page in the key.
- **`wotw provenance rotate`.** Archive the current chain file and
  start a new one whose seq-1 record cryptographically commits to the
  final chain hash of the archived file. This removes the "the chain
  grows forever" footgun.
- **Retry semantics for the dead-letter queue.** A `wotw dlq retry
  <batch_id>` command that re-enqueues a failed batch against the
  current wiki state. Needs careful provenance semantics so a
  retry-after-archive doesn't silently skip the archive.
- **Prometheus metrics endpoint.** `/metrics` on the MCP server
  returning queue depth, cost-today, failed-batch count, last-ingest
  duration, and provenance chain length. Disabled by default; opt-in
  via config.

---

## 🔭 Planned (no committed version)

- **External provenance signing.** Sigstore / minisign support so the
  chain head can be published to a public log and externally verified
  without trusting the daemon. We want this gated behind a config
  flag so air-gapped deployments don't pay the network cost.
- **Pluggable embeddings for search.** Current search is pure
  minisearch (BM25-ish). A pluggable embedding store (local with
  `sqlite-vec`, remote with Voyage/OpenAI) would dramatically improve
  recall on paraphrased queries.
- **Streaming ingestion progress.** Today the MCP `synthesize` and
  `query` tools return a single response after completion. Streaming
  progress (tool calls, partial tokens) would make long operations
  less opaque.
- **Git-hosted provenance backups.** Push the provenance chain (not
  the wiki) to a separate git remote on every N appends, so losing
  the wiki drive doesn't lose the audit trail. Must never push
  secrets.
- **`wotw doctor`.** A one-shot environment check that verifies the
  Claude CLI is installed, the API key works, the wiki store is
  writable, the git repo is healthy, and the provenance chain is
  valid. Useful as the first command a new user runs after `init`.
- **Declarative ingest rules.** A `wotw.ingest.yaml` where users can
  say "files matching `raw/research/*.pdf` use prompt
  `research.prompt.md` and category `source`" so the same daemon can
  handle multiple kinds of input with different conventions.
- **Wiki diff UI.** A tiny static HTML viewer for the wiki git log
  that lets you scrub through versions of a page and see the
  provenance record that produced each commit. Static = no extra
  runtime cost.

---

## ❄️ Won't build (for now, and why)

- **Vector database as a service.** We deliberately don't ship a
  hosted service; `wotw` is a self-hosted daemon. If you want
  "Anthropic-style hosted" semantics, run the daemon on a VPS.
- **Multi-wiki in one daemon.** One wiki per process is a load-bearing
  simplification. Want two wikis? Run two daemons on two ports. The
  complexity cost of sharing an ingestion queue across isolated wikis
  isn't worth the RAM saving.
- **Arbitrary LLM backend.** We optimize for Claude. PRs that add
  support for other backends are welcome in principle but won't get
  the same level of testing or prompt tuning.
- **A GUI.** The CLI + MCP surface is the supported interface. If
  you want a GUI, build one against the MCP tools — that's what they
  exist for.
- **Auto-retry of failed batches.** The dead-letter queue is
  deliberately manual: failed batches land in a JSONL ledger and stay
  there until an operator decides what to do. Auto-retry is a classic
  source of surprise bills.

---

## How to propose a roadmap item

Open a GitHub issue titled `[roadmap] <idea>` with:

1. The problem you're trying to solve (in ≤ 3 sentences — the
   "why").
2. How you'd know `wotw` had solved it (the success criterion).
3. Whether you're volunteering to implement it.

If it's in scope, a maintainer will move it into "Planned" or
"In flight." If it's explicitly out of scope we'll add it to
"Won't build" with a rationale so the next person asking sees the
answer.
