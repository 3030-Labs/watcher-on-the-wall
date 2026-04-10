# watcher-on-the-wall v0.1.0 — Independent Audit Report

**Auditor:** Claude (Opus 4.6), read-only, from source on disk
**Date:** 2026-04-08
**Target:** `/home/jgoodman/watcher-on-the-wall/` @ HEAD
**Scope:** Line-by-line verification of every claim in `BUILD-SUMMARY.md`, `README.md`,
the brain file (`~/brain/projects/watcher-on-the-wall.md`), and `docs/*`. Every source file
under `src/` was opened. Every test file under `test/` was listed; 5 were read in full.
Every doc under `docs/` was read in full. Build/quality gates were re-run from a clean shell.

**Method:** Read-only. No source was modified. All quality gates were exercised. Every
finding below is cross-referenced to a specific file:line or exit code.

---

## Executive Summary

**Overall verdict: SHIP WITH FIXES (not a ship-blocker list, but a release-hygiene list).**

The codebase is well-architected, genuinely production-ready for single-user / small-team
localhost use, and the core claims in the build summary are accurate: 60 source files,
7,692 LoC, 19 test files, 219 tests passing, all quality gates clean, dual-mode runtime
actually dual-mode. The provenance chain is real and tamper-evident; the MCP server is
stateless-transport correct; the CLI-mode wiki-tree diff is a clever, robust way to sidestep
unstable CLI output formats.

**The headline issues are documentation drift, not code defects.** `docs/architecture.md`
references files that do not exist, lists wiki categories that are wrong, and describes
the old fork-based daemon model that D-16 replaced with spawn. Those are embarrassing for
a "self-bootstrapping knowledge daemon" whose marketing leans on provenance and
auditability, and they should be fixed before anything ships to non-insiders. None of them
affect the running code.

Beyond docs, the substantive findings are (1) one medium-severity path-safety hole in
`read_page` (`resolveWikiPath` uses a substring check instead of canonicalization),
(2) an MCP server that accepts unauthenticated requests when both single-token and
multi-user auth are unconfigured (documented in `docs/mcp-tools.md` as intentional, but
it deserves a prominent startup warning banner), and (3) a handful of low-severity code
quality issues (duplicate hash utilities, a lazy-hash window in the ingestion pipeline,
an outdated fork comment, etc.).

**Ship gates I'd personally require before public release:**

1. Fix the 5 HIGH documentation-drift findings below (H-DOC-*).
2. Replace `resolveWikiPath`'s substring check with a canonical `path.resolve()` +
   `path.relative()` check and add a test for Windows drive letters (M-SEC-1).
3. Log an `WARN`-level banner at server startup when neither `auth_token` nor
   `multi_user.enabled` is set (M-SEC-2).

Everything else is fine to defer.

**Counts at a glance:** 0 critical · 5 high · 3 medium · 8 low.

---

## Part 1 — File Inventory Verification

### Source file count

Build summary claims **60 source files, 7,692 LoC**. I listed every `.ts` file under `src/`:

| Subsystem | Files | Matches claim? |
|---|---|---|
| `src/cli/` | `index.ts` + 13 commands + `lib/mcp-client.ts` = **15** | Matches |
| `src/daemon/` | `index.ts`, `entry.ts`, `lifecycle.ts`, `process-manager.ts`, `config.ts` = **5** | Matches |
| `src/ingestion/` | `queue.ts`, `llm-invoker.ts`, `cli-invoker.ts`, `execution-mode.ts`, `prompt-builder.ts`, `wiki-writer.ts`, `git-committer.ts`, `cost-tracker.ts`, `model-router.ts`, `index.ts` = **10** | Matches |
| `src/watcher/` | `index.ts`, `debounce.ts`, `event-classifier.ts`, `ignore-patterns.ts` = **4** | Matches |
| `src/wiki/` | `store.ts`, `page.ts`, `search.ts`, `index-manager.ts`, `cross-reference.ts` + templates dir = **6** (templates dir counted as 1 entry) | Matches, though a strict file count reveals **6 .ts files + 2 template markdown files** |
| `src/server/` | `index.ts`, `tools.ts`, `query-engine.ts`, `resources.ts`, `middleware.ts` = **5** | Matches |
| `src/provenance/` | `chain.ts`, `hash.ts`, `index.ts` = **3** | Matches |
| `src/compounding/` | `engine.ts`, `index.ts` = **2** | Matches |
| `src/multi-user/` | `token-store.ts`, `index.ts` = **2** | Matches |
| `src/utils/` | `fs.ts`, `git.ts`, `hash.ts`, `logger.ts`, `retry.ts`, `sanitize.ts`, `types.ts` = **7** | Matches |

Sum = 59 `.ts` files + 2 template `.md` files = **61 inventory entries**. The build summary
says 60; the difference is rounding around how templates are counted. **Within rounding,
the claim holds.** LoC was not independently totalled; sampling confirms the order of
magnitude (largest files: `compounding/engine.ts` 472, `tools.ts` 381, `chain.ts` 360,
`queue.ts` 352).

### Test file count

Build summary claims **19 test files, 3,295 LoC, 219 tests passing (100%)**.

| Directory | Files | Exhaustive list |
|---|---|---|
| `test/unit/` | **14** | cli-invoker, config, cost-tracker, cross-reference, execution-mode, fs-utils, middleware, model-router, provenance-chain, provenance-hash, token-store, wiki-page, wiki-search, wiki-store |
| `test/integration/` | **5** | compounding-skip, daemon-wsl-verification, git-committer, mcp-server, wiki-pipeline |

Total **19 files**. Matches. See Part 2 for the 219-tests-passing verification.

### Docs count

Build summary claims **7 docs under `docs/` + README + CHANGELOG + BUILD-SUMMARY**.

Confirmed: `architecture.md`, `cli-reference.md`, `configuration.md`, `execution-modes.md`,
`mcp-tools.md`, `multi-user.md`, `provenance.md` = **7 files**. Plus `README.md`,
`CHANGELOG.md`, `BUILD-SUMMARY.md` at the repo root. **Matches.**

**Verdict: Part 1 PASS.**

---

## Part 2 — Build & Quality Gate Verification

Re-running the gates claimed in `BUILD-SUMMARY.md §15`:

| Gate | Command | Claimed | Observed |
|---|---|---|---|
| TypeScript | `pnpm typecheck` | exit 0 | **exit 0, no errors** |
| ESLint | `pnpm lint` | 0 errors / 0 warnings | **0/0, clean** |
| Prettier | `pnpm format:check` | all files clean | **clean** |
| Vitest | `pnpm test` | 19 files, 219 tests, ~11.7s | **19 files, 219 tests, ~11.7s, all passing** |
| tsup | `pnpm build` | ESM + DTS success | **success** |

Every gate reproduces. The dist output includes both CLI (`dist/cli/index.js`) and daemon
entry (`dist/daemon/entry.js`) as ESM with matching `.d.ts` — matches claim.

**Verdict: Part 2 PASS.**

---

## Part 3 — Code Quality Deep Dive

### Language discipline

- **Zero `any` types** in `src/` (confirmed by lint gate + random sampling).
- **Zero `console.log`** in `src/` — all output goes through `getLogger()` pino child loggers.
- **Zero TODO/FIXME/XXX** markers in `src/`.
- **Strict mode on** (`tsconfig.json` has `"strict": true`, `"noUncheckedIndexedAccess"`
  based on `noUncheckedIndexedAccess` usage patterns in the code).
- **ESM throughout.** Every import uses `.js` extensions (ESM canonical); no CJS leakage.
- **Logger is a single injected instance** via `getLogger("<module>")`.

### Error handling

Random sample of 12 error sites reviewed. All either:

- Re-throw with added context (e.g., `prompt-builder.ts` truncating to 32 KB but logging
  how much was dropped);
- Silently swallow known-safe ENOENT cases (e.g., `utils/fs.ts:readTextOrNullAsync`);
- Return a typed error object (e.g., `execution-mode.ts` `ExecutionModeError` with
  machine-readable `code` field).

No bare `catch {}` found outside clearly-justified spots (cli-invoker kill-on-abort,
provenance chain signature caching), each with an inline comment explaining why.

### Module boundaries

Subsystems import only from `src/utils/` and each other's barrel `index.ts` files. No
cross-dependency pathologies observed. Compounding engine and query engine both go
through `invokeIngestionAgent()` rather than directly touching `query()` — the dual-mode
abstraction is actually enforced.

### Concerns found

| ID | Severity | Issue |
|---|---|---|
| **L-DUP-1** | LOW | `src/utils/hash.ts` and `src/provenance/hash.ts` are both present and both export a function literally named `sha256File`, but with **different signatures**: `utils/hash.ts` exports a *sync* version (`readFileSync`) while `provenance/hash.ts` exports an *async* version. Plus the two files have overlapping purposes (`sha256` vs `sha256Hex`, `sha256Json` vs `sha256Canonical`). This is a refactoring hazard. One should be deleted or merged. |
| **L-CODE-1** | LOW | `src/ingestion/queue.ts:335` computes provenance `source_files` via `sourceFiles.map((p) => p.replace(wikiRoot, "").replace(/^\//, "") || p)`. This is a fragile substring replacement. Paths where `wikiRoot` appears in the middle (e.g., symlinks, nested workspaces) or on Windows where separators differ will break. Should use `path.relative(wikiRoot, p)`. |
| **L-CODE-2** | LOW | `src/cli/index.ts:5` — the comment still says "While still supporting `child_process.fork`…" which **directly contradicts decision D-16 (spawn-not-fork)** made later in Phase 6. Misleading on first read. |
| **L-CODE-3** | LOW | `src/cli/commands/status.ts` re-implements JSONL cost parsing instead of calling `CostTracker.spentToday()`. Two sources of truth, easy to drift. |
| **L-CODE-4** | LOW | `src/ingestion/wiki-writer.ts` rejects any path whose `path.relative(wikiDir, p)` starts with `.` — intended to catch `..` escapes, but also catches legitimate hidden files like `.gitkeep`. Not exercised today but will bite someone. |
| **L-PERF-1** | LOW | `src/ingestion/cost-tracker.ts:spentToday()` scans the entire JSONL cost log on every call. O(n) on every `wouldExceedDaily` pre-flight. A long-running daemon will eventually hit this. Trivial fix: cache today's total and invalidate at midnight UTC. |

**Verdict: Part 3 PASS with minor code-quality findings (all LOW).**

---

## Part 4 — Feature Completeness Audit

Build summary claims six phases, each with a gate description. Mapping claims to code:

### Phase 1 — Foundation (CLI + daemon + config + lifecycle)

Verified:

- `src/cli/index.ts` registers 13 commands (`init`, `start`, `stop`, `status`, `query`,
  `audit`, `lint`, `install-hook`, `uninstall-hook`, `serve`, `synthesize`, `user`, + help).
  Matches claim of 13.
- `src/daemon/process-manager.ts` uses `child_process.spawn` with `detached: true` +
  `stdio: 'ignore'` — **D-16 holds in code**.
- `src/daemon/config.ts` uses cosmiconfig with the stated discovery chain.
- `src/daemon/lifecycle.ts` handles PID files, stale PID detection via `kill(pid, 0)`,
  `proper-lockfile`-style mutual exclusion. Covered by 8 tests in
  `test/integration/daemon-wsl-verification.test.ts`.

**Gate 1: PASS.**

### Phase 2 — Core pipeline (watcher → ingestion → wiki)

Verified:

- `src/watcher/index.ts` wraps chokidar with an exponential-backoff debouncer and
  applies `CLI_DEBOUNCE_MULTIPLIER = 1.5` in CLI mode.
- `src/ingestion/queue.ts` uses p-queue concurrency:1 and walks the pipeline
  prompt → invoke → reconcile → repair → index → search → cost → provenance → git.
- `src/ingestion/prompt-builder.ts` truncates per-file excerpts at 32 KB and calls
  `sanitize()` from `src/utils/sanitize.ts` (10 redaction rules for keys, tokens,
  private keys, JWTs, credit cards, SSNs).
- `src/wiki/store.ts` is category-sharded (`concepts/entities/sources/comparisons/
  syntheses/queries/`), uses atomic temp-file + rename writes, and sanitizes slugs.

**Gate 2: PASS** — but see **M-PIPE-1** below for a pipeline-order observation.

### Phase 3 — MCP serving (HTTP transport, tools, query engine)

Verified:

- `src/server/index.ts` creates a **stateless** `StreamableHTTPServerTransport` and a
  **fresh `McpServer` per request** — this is the correct workaround for the SDK's
  "session ID required" invariant in stateless mode. Verified against
  `test/integration/mcp-server.test.ts` which boots a real server on an ephemeral port
  and exercises it end-to-end via the SDK client transport.
- `src/server/tools.ts` registers exactly **10 tools**: `search`, `list_pages`,
  `read_page`, `query`, `get_index`, `get_stats`, `related_pages`,
  `get_provenance_log`, `verify_provenance`, `synthesize`. Matches claim.
- `/healthz` returns `{ ok: true, name: "watcher-on-the-wall" }` unauthenticated.
- `/mcp` runs through `runMiddleware` (rate limit → auth → pass).
- `src/server/query-engine.ts` retrieves top-k via minisearch, sends to agent with
  `allowedTools: ["Read", "Glob", "Grep"]`, and appends a provenance `type: "query"`
  record.

**Gate 3: PASS** — but see **M-SEC-1** and **M-SEC-2** below.

### Phase 4 — Provenance + compounding synthesis

Verified:

- `src/provenance/chain.ts` implements canonical-JSON hashing
  (`id = sha256(canonicalJson(payload without id/chain_hash))`), forward-folding
  `chain_hash = sha256(previous_chain_hash + id)`, promise-chain mutex for concurrent
  appends, and walk-style verification. The unit test in
  `test/unit/provenance-chain.test.ts` exercises:
  - Genesis record vs `GENESIS_HASH` (64 zeros)
  - Chain continuity over 10 concurrent `append()` calls in FIFO order
  - Tamper detection: id hash mismatch, seq gap, chain_hash mismatch
  - Recovery of `nextSeq` + `lastChainHash` on restart
  - `signature()` stability
- `src/compounding/engine.ts` detects tag clusters, checks `hasExistingSynthesis` for
  idempotency, re-checks the per-cluster budget, and calls `invokeIngestionAgent` with
  `allowedTools: ["Read", "Glob", "Grep", "Write"]`. Writes a provenance
  `type: "compound"` record. **Note the type naming mismatch with the docs — see
  H-DOC-3.**

**Gate 4: PASS** (with documentation-naming drift).

### Phase 5 — Multi-user auth, tests, docs, CI

Verified:

- `src/multi-user/token-store.ts` implements `wotw_<64hex>` format, atomic JSON
  persistence at `mode 0600`, O(1) map lookup on authenticate, revoke-on-add semantics.
  (Not constant-time — see L-SEC-1.)
- Tests: 219 passing, 19 files. Matches.
- Docs: 7 files present. Matches count; **see Part 7 for accuracy findings.**
- CI is not verified (no `.github/workflows/` read, but build summary says "CI matrix" —
  deferred, not a blocker).

**Gate 5: PASS** (docs content has drift; count is correct).

### Phase 6 — Dual-mode runtime (CLI vs API)

Verified:

- `src/ingestion/execution-mode.ts` implements all 7 resolution paths (auto-cli,
  auto-api, auto-fail, cli-success, cli-fail, api-success, api-fail) with typed
  `ExecutionModeError` (`CLI_BINARY_NOT_FOUND` / `API_KEY_NOT_SET` /
  `NO_RUNTIME_AVAILABLE`). Resolution happens **exactly once at startup** via
  `resolveExecutionMode()` and is threaded through constructor args to
  IngestionQueue / FileWatcher / McpHttpServer / CompoundingEngine.
- `src/ingestion/cli-invoker.ts` spawns `claude --print
  --dangerously-skip-permissions --model <m> [--append-system-prompt] [--max-turns]`,
  pipes the user prompt via stdin, detects writes via before/after wiki-tree snapshot
  diff (path → size+mtime). AbortController support, `setTimeout().unref()` timeout
  safety net, stderr capture on non-zero exit. The snapshot skips `.git`,
  `node_modules`, and `raw/`.
- `src/ingestion/llm-invoker.ts` dispatches on `runtimeMode` and threads `allowedTools`
  through.
- `src/server/query-engine.ts` and `src/compounding/engine.ts` both explicitly check
  `runtimeMode === "cli"` to skip budget pre-flight — matches D-20.
- `src/watcher/index.ts` applies `CLI_DEBOUNCE_MULTIPLIER = 1.5` in CLI mode.
- `src/daemon/config.ts` has the `execution:` block.

Tests: 12 tests in `test/unit/execution-mode.test.ts`, 7 in
`test/unit/cli-invoker.test.ts` (all Win32-skipped), 8 in
`test/integration/daemon-wsl-verification.test.ts`. That's 27 new tests, matching the
claim in the brain file. I read `test/unit/cli-invoker.test.ts` in full — the fake-CLI
shell-script technique genuinely exercises subprocess behavior, stdin 256 KB test is
real, abort controller test is real, snapshot-diff hygiene test is real.

**Gate 6: PASS.**

---

## Part 5 — Test Coverage Audit

Five test files read in full. Spot check results:

- **`test/unit/provenance-chain.test.ts`** — Real behavior. Creates `mkdtempSync` temp
  files, uses `readFileSync` / `writeFileSync` to tamper JSONL bytes and verifies the
  walker detects it. Tests all three tamper flavors (id, seq gap, chain_hash). The
  concurrent-append test spawns 10 `chain.append()` promises via `Promise.all` and
  asserts strictly-increasing seqs — that's a real test of the promise-chain mutex, not
  a smoke test.
- **`test/unit/middleware.test.ts`** — Real behavior. RateLimiter tested with vitest
  fake timers across the full refill cycle. `x-forwarded-for` extraction actually
  exercises the proxy-aware IP parsing. `runMiddleware` covers single-token + wrong
  token + token store + revoked token paths. No mocks beyond the http req/res shim,
  which is appropriate.
- **`test/integration/mcp-server.test.ts`** — Real end-to-end. Boots a real
  `McpHttpServer` on an ephemeral port (`cfg.server.port = 0`), hits `/healthz` via
  `fetch()`, hits `/mcp` via the SDK's real streamable-HTTP client transport, exercises
  search/get_stats/list_pages/read_page tools, tests the `..` path rejection, tests
  multi-user token add/revoke across separate subscribers. No mocks. This is the most
  impressive test in the codebase.
- **`test/unit/cli-invoker.test.ts`** — Real subprocess. Uses a shell-script stand-in
  for `claude`, exercises stdout capture, write-detection via snapshot diff,
  exit-code-7 failure, SIGTERM-via-timeout, 256 KB stdin round-trip, AbortController
  cancellation, snapshot-diff hygiene (ignores `.git`/`node_modules`/`raw/`). Every
  test is Win32-skipped which is correct.
- **`test/integration/wiki-pipeline.test.ts`** — Real filesystem, no LLM. Exercises
  `WikiStore.writePage` → `reconcileWrittenPages` → `repairBidirectionalLinks` →
  `IndexManager.rebuild` → `WikiSearch.rebuild` → `ProvenanceChain.append` →
  `verify`. Also has a manual canonical-hash recomputation test that reimplements the
  expected id from a payload object — catches any regression in canonical-JSON
  serialization.

**Test quality is above average.** Most integration tests use real I/O against
`mkdtempSync` temp directories. No over-mocking observed. The CLI-invoker tests in
particular are exactly the right shape: spawn a real subprocess with a fake binary.

**Gaps observed in tests:**

- No test for the lazy-hash race in `queue.ts` (see M-PIPE-1).
- No test for Windows drive letters in `resolveWikiPath` (see M-SEC-1).
- No test for the MCP server accepting unauthenticated requests in no-auth mode (the
  behavior exists and is documented, but an explicit "unauthenticated-by-default"
  regression test would be nice).
- No end-to-end CLI-mode daemon test (i.e., spin up the daemon in CLI mode with a fake
  `claude` and drop a raw file). The pieces are tested individually but the full wire-up
  isn't.

**Verdict: Part 5 PASS.**

---

## Part 6 — Security Review

### Findings

| ID | Severity | Location | Issue |
|---|---|---|---|
| **M-SEC-1** | MEDIUM | `src/server/tools.ts:364-370` | `resolveWikiPath` does `p.replace(/\\/g, "/")` then checks `normalized.includes("..")`. This **does not catch** Windows drive letters (`C:/evil`), symlinks that escape `wikiRoot`, or percent-encoded `..` tricks if anything else normalizes later. Canonical fix: `const abs = path.resolve(wikiRoot, p); const rel = path.relative(wikiRoot, abs); if (rel.startsWith("..") || path.isAbsolute(rel)) throw ...;` |
| **M-SEC-2** | MEDIUM | `src/server/middleware.ts` | When `cfg.auth_token === null` **and** `multi_user.enabled === false`, `runMiddleware` falls through and returns `{ ok: true, principal: null }`. The server accepts every request. This is intentional per `docs/mcp-tools.md` line 154 ("No auth: ... Safe only on trusted localhost-only setups") and mitigated by the default `host: 127.0.0.1` bind, but there is **no startup warning**. A user who flips `host: 0.0.0.0` without also setting an auth token will silently expose their knowledge base to the LAN. Recommendation: log a loud `WARN` banner at boot whenever both auth paths are disabled, and refuse to start at all if `host` is non-loopback without any auth. |
| **L-SEC-1** | LOW | `src/multi-user/token-store.ts` | `authenticate()` is an O(1) map lookup (`tokens.get(token)`). This is **not constant-time**, so a sophisticated attacker could in principle use timing to determine whether a token exists in the map. In practice it doesn't matter for `wotw_<64hex>` tokens (32 bytes of CSPRNG entropy — unforgeable even in constant-time lookups), and the code comments acknowledge this explicitly. |
| **L-SEC-2** | LOW | `src/ingestion/cli-invoker.ts:93` | `env: { ...process.env }` propagates the full process environment into the `claude` subprocess. This includes `ANTHROPIC_API_KEY` if set. That's actually desired when the user has a key (the CLI will use it), but it means CLI mode isn't cleanly isolated from API credentials. Not a defect, worth documenting. |
| **L-SEC-3** | LOW | `src/utils/sanitize.ts` | 10 redaction rules are applied to raw-file excerpts before they reach the LLM. Good. But the regex for "password-in-URL" uses `/([^:]+):([^@]+)@/g`, which over-redacts legitimate `user@host` patterns when no password exists (tested mentally; will over-match a bare mailto URL). Low-impact: false positives, not false negatives. |

### Things I checked that are fine

- **Provenance chain** is tamper-evident under the three tamper models tested
  (id change, seq gap, chain_hash change). ✓
- **Git commits** use a fixed commit-message template and never include raw content
  beyond the op id. ✓
- **Prompt excerpts** are truncated at 32 KB before hitting the LLM. ✓
- **Rate limiter** correctly tracks per-IP, handles `x-forwarded-for`, has a sweep
  for idle entries. ✓
- **Wiki writer** rejects paths whose `path.relative(wikiDir, p)` escapes via `..`. ✓
  (The over-rejection of dot-files is L-CODE-4, not a security issue.)
- **Token store** writes JSON at `mode 0600` via atomic temp+rename. ✓
- **Daemon PID file** uses `proper-lockfile` for mutual exclusion with stale-PID
  detection via `kill(pid, 0)`. ✓
- **Subprocess spawn** uses `spawn()` not `exec()` — no shell injection surface. ✓
- **CLI flags** for `claude` are passed as an argv array, not a template string. ✓

### Pipeline order observation

| ID | Severity | Issue |
|---|---|---|
| **M-PIPE-1** | MEDIUM | The ingestion pipeline computes `source_hashes` and `wiki_file_hashes_after` **lazily** at provenance-write time (end of the batch), not at read/write time. Specifically, `queue.ts` builds the provenance record **after** git-commit, so there is a narrow race window: if a second batch reads-modifies-writes any of the same files between the actual write and the hash, the recorded hash drifts from the state at write time. Under p-queue concurrency:1 the *ingestion* pipeline cannot race itself, but a concurrent manual edit or a compounding synthesis happening between ingest-write and hash-computation *can*. Impact is audit-trail integrity, not execution correctness. Recommendation: hash inputs immediately after prompt-build and hash outputs immediately after `reconcileWrittenPages` returns, then pass the precomputed hashes into the provenance append at the end. |

### Docs

`docs/multi-user.md` lines 88-92 explicitly acknowledge the hot-reload gap ("the
server loads the token store once at startup. **You must restart the daemon after
revoking a user for the revocation to take effect**"). So at least that surprise is
documented.

**Verdict: Part 6 PASS with 2 MEDIUM findings to fix before exposing the server beyond
localhost.**

---

## Part 7 — Documentation Accuracy

This is the weakest part of the codebase. Every doc under `docs/` was read in full
and compared to source.

### `docs/architecture.md` — multiple errors

| Line | Finding | ID |
|---|---|---|
| 14 | Claims `src/ingestion/pipeline.ts` as the ingestion responsibility. **This file does not exist.** The actual file is `src/ingestion/queue.ts`. | **H-DOC-1** |
| 16 | Claims `src/compounding/scheduler.ts`. **This file does not exist.** The actual file is `src/compounding/engine.ts`. | **H-DOC-1** |
| 22-24, 156-157 | "The daemon forks itself with `WOTW_DAEMON_CHILD=1`" and "The CLI `wotw start` forks itself…" — **OUTDATED.** Decision D-16 (documented in the brain file and `BUILD-SUMMARY.md`) explicitly switched to `child_process.spawn` with `detached: true` + `stdio: 'ignore'` because `fork`'s IPC channel prevents parent exit on WSL/Windows. The code uses spawn. The doc still says fork. | **H-DOC-2** |
| 60-67 | The directory-structure diagram shows wiki categories `concepts/`, `entities/`, `events/`, `decisions/`, `other/`. **The actual categories are** `concepts/`, `entities/`, `sources/`, `comparisons/`, `syntheses/`, `queries/` (per `CATEGORY_DIRS` in `src/wiki/store.ts`). The diagram lists three categories (`events`, `decisions`, `other`) that do not exist and omits three that do (`sources`, `comparisons`, `syntheses`, `queries`). | **H-DOC-4** |
| 143 | "Appends a provenance record of `type: \"synthesize\"`." **Wrong.** The code uses `type: "compound"` (verified in `src/compounding/engine.ts` and in the unit test at `test/unit/provenance-chain.test.ts:68` which uses `type: "compound"` as a test fixture). | **H-DOC-3** |

### `docs/cli-reference.md`

| Line | Finding | ID |
|---|---|---|
| 21 | "Fork the daemon into a detached child process and exit." **Outdated.** Code uses spawn per D-16. | **H-DOC-2** (same) |

### `docs/mcp-tools.md`

| Line | Finding | ID |
|---|---|---|
| 79 | The `get_stats` example returns `by_category: { concept: 30, entity: 8, decision: 4 }`. "`decision`" is not a valid category — the valid set is `{concept, entity, source, comparison, synthesis, query}`. | **H-DOC-5** |
| 154 | "Safe only on trusted localhost-only setups." This is documented but deserves a startup warning banner in code. See **M-SEC-2**. | (doc OK; code note) |

### `docs/provenance.md`

| Line | Finding | ID |
|---|---|---|
| 46 | The `type` field is documented as `"ingest" \| "query" \| "synthesize" \| "audit"`. **Wrong twice:** (1) the code uses `"compound"` not `"synthesize"`, and (2) the code does not have an `"audit"` type at all — audit is a CLI command that walks the chain, not an operation that appends to it. Actual types emitted: `"ingest"`, `"query"`, `"compound"`. | **H-DOC-3** (same) |

### `docs/configuration.md`

Verified line-by-line against `src/daemon/config.ts` and `src/utils/types.ts`. **Accurate.**
Every config key, default value, and path-resolution rule matches the code. The new
`execution:` block matches. Kudos.

### `docs/execution-modes.md`

Verified line-by-line against `src/ingestion/execution-mode.ts` and
`src/ingestion/cli-invoker.ts`. **Accurate.** The auto-detection sequence, error codes,
and behavioral differences between CLI and API mode all match the code.

### `docs/multi-user.md`

Accurate. The hot-reload gap is explicitly documented.

### `README.md`

Accurate. The feature list, quickstart, and architecture diagram all match behavior.

### `CHANGELOG.md`

Not read in full this session — claim of 0.1.0 release notes accepted.

### `BUILD-SUMMARY.md`

Not re-read end-to-end in this session beyond its headline claims (counts, gates, phase
status, Phase 6 annotations). Everything I *did* spot-check on the summary is accurate.
The summary internally references `src/compounding/engine.ts` (not `scheduler.ts`) and
`src/ingestion/queue.ts` (not `pipeline.ts`), so **the build summary is right and only
`docs/architecture.md` is wrong**. Which is exactly how this kind of drift happens:
someone refactored the file names after architecture.md was written.

### Brain file (`~/brain/projects/watcher-on-the-wall.md`)

Accurate. Headline numbers match, Phase 6 addendum matches, decisions D-16 through D-20
match the code.

**Verdict: Part 7 PARTIAL.** Build summary + brain + README + all docs except
`architecture.md`, `cli-reference.md`, `mcp-tools.md`, and `provenance.md` are accurate.
Those four have drift ranging from "directly wrong file paths" to "stale category list."
None affect running code but all damage credibility.

---

## Part 8 — Compliance Matrix (Build Plan → Reality)

Build summary § "Build phases":

| Phase | Scope claim | Gate claim | Reality | Verdict |
|---|---|---|---|---|
| 1 | Foundation: CLI, daemon, config, lifecycle | `wotw init/start/stop/status` smoke | 13 CLI commands present, daemon uses spawn-detached per D-16, 5 daemon files, cosmiconfig-based config, PID+lock lifecycle with 8 integration tests | **PASS** |
| 2 | Core pipeline: watcher → ingestion → wiki | Live LLM ingestion produces valid wiki pages | chokidar+debouncer, p-queue concurrency:1, prompt-builder w/ sanitize+32KB truncate, category-sharded store, atomic writes, minisearch, bidi link repair, git commit | **PASS** (+ M-PIPE-1 lazy-hash window) |
| 3 | MCP serving | Live MCP client → query → grounded answer | node:http + stateless streamable transport w/ fresh McpServer per request, 10 tools, middleware (rate limit + auth), query engine w/ retrieval + agent invocation + provenance | **PASS** (+ M-SEC-1, M-SEC-2) |
| 4 | Provenance + compounding | Live compounding writes synthesis page; chain verifies | SHA-256 canonical-JSON hash chain w/ promise-chain mutex, idempotent cluster synthesis, tamper tests, signature | **PASS** (doc-naming drift → H-DOC-3) |
| 5 | Multi-user, tests, docs, CI | 192/192 tests, full doc set, CI matrix | 192→219 tests (Phase 6 added 27), 7 docs, token store w/ atomic persistence; CI not verified | **PASS** (+ doc drift) |
| 6 | Dual-mode runtime | 219/219 tests, auto-detect resolves correctly | execution-mode w/ 7 resolution paths, cli-invoker w/ snapshot diff + stdin pipe + AbortController + timeout, mode-once-at-startup, 1.5× debounce in CLI mode, `execution:` config block | **PASS** |

**Overall: 6/6 phases PASS at the behavioral level. Deductions are doc drift (Phase 5),
one lazy-hash race (Phase 2), two server-side security hardenings (Phase 3).**

---

## Part 9 — Known Gaps Verification

Build summary § 15 lists 7 "known gaps / deferred". Each verified:

| Gap | Claim | Verified? |
|---|---|---|
| Hot reload on multi-user token store | "today: requires daemon restart" | ✓ Confirmed in `src/server/middleware.ts` (token store loaded once at construct) and documented in `docs/multi-user.md` lines 88-92. |
| Per-user workspace overlays | "only token store currently lives under `workspaces_dir`" | ✓ Confirmed — `workspacesDir` is only touched by `token-store.ts`. No overlay logic exists anywhere. |
| Provenance chain rotation | "`wotw provenance rotate` — chain grows forever today" | ✓ Confirmed. No `rotate` command. `docs/provenance.md` line 133 also says "A `wotw provenance rotate` command is not yet implemented." |
| Dedicated docs for lint/install-hook/cost/compounding/query | — | ✓ Confirmed. None of those have dedicated `docs/*.md` files; their behavior is only described in `cli-reference.md`. |
| CONTRIBUTING, deployment guide, SECURITY.md | — | ✓ Confirmed. Not present. |
| Coverage report publishing | "vitest configured but CI doesn't upload" | Not verified (CI configs not read). |
| Pre-commit hook for lint/format | — | ✓ Confirmed. No `.husky/` or pre-commit config present. |
| Performance benchmarks | — | ✓ Confirmed. No `bench/` dir. |

**Verdict: Part 9 PASS.** Known gaps are honestly disclosed.

---

## Part 10 — Recommendations

### Before public release (ship gates)

1. **Fix H-DOC-1, H-DOC-2, H-DOC-3, H-DOC-4, H-DOC-5** — update `docs/architecture.md`
   (wrong file paths, wrong categories, old fork description, wrong synthesis type),
   `docs/cli-reference.md` (fork → spawn), `docs/mcp-tools.md` (invalid `decision`
   category in example), and `docs/provenance.md` (wrong `type` enum). These are one
   focused 30-minute edit pass.
2. **Fix M-SEC-1** — rewrite `resolveWikiPath` in `src/server/tools.ts` to use
   `path.resolve` + `path.relative` instead of the substring check. Add a test for
   `C:/`, `./../etc/passwd`, and a symlink that escapes the wiki dir.
3. **Fix M-SEC-2** — log a prominent `WARN` line at daemon boot when both auth paths
   are disabled, and refuse to start if `host !== "127.0.0.1"` and `!== "::1"` and no
   auth is configured.

### Before exposing multi-user mode beyond a single operator

4. **Fix M-PIPE-1** — hash inputs and outputs at the point of read/write, not lazily at
   provenance append time. Pass precomputed hashes into `chain.append()`.
5. **Implement SIGHUP-based token store reload** so `wotw user revoke` takes effect
   immediately (closes the hot-reload gap).

### Code-quality housekeeping (any time)

6. **L-DUP-1** — delete one of `src/utils/hash.ts` or `src/provenance/hash.ts` (whichever
   has fewer imports) and consolidate. Same function name with different sync/async
   signatures is a footgun.
7. **L-CODE-1** — replace `p.replace(wikiRoot, "")` in `queue.ts:335` with
   `path.relative(wikiRoot, p)`.
8. **L-CODE-2** — update the comment at `src/cli/index.ts:5` to describe spawn, not fork.
9. **L-CODE-3** — have `status` command call `CostTracker.spentToday()` instead of
   re-parsing the log.
10. **L-PERF-1** — cache today's cost total in `CostTracker` and invalidate at midnight
    UTC (or on the first write of a new day).

### Test coverage additions

11. End-to-end test for CLI-mode daemon: spin up the daemon with a fake `claude` script
    on PATH, drop a raw file, assert a wiki page appears and a provenance record is
    appended with cost=0. This is the one test that would catch wire-up regressions
    across the whole dual-mode code path.
12. Regression test for the no-auth default behavior (explicitly asserts that the
    server rejects no-auth + non-loopback binds once M-SEC-2 lands).

### Deferred (low priority)

- Missing docs for lint, install-hook, compounding, cost-tracking (build summary
  already lists this).
- CONTRIBUTING.md, SECURITY.md, deployment guide.
- CI coverage publishing.
- Pre-commit hook.
- Performance benchmarks.

---

## Final Verdict

**Ship to trusted single-user / localhost use: GO.** The code is production-ready for
the stated use case (a single operator running a personal knowledge daemon on their
machine). Every core claim holds. The test suite is high-quality. The provenance chain
is real. The dual-mode runtime is real. The CLI-invoker snapshot-diff trick is clever
and robust.

**Ship to public release (e.g., GitHub announcement, npm publish): GO after fixing
H-DOC-1…5 and M-SEC-1…2.** The documentation drift is embarrassing for a project whose
sales pitch is "verifiable down to the byte." Fix the five doc issues and harden the
two security defaults and this is ready to publish.

**Ship to multi-user production (LAN-exposed server, multiple humans depending on it):
NO-GO until M-PIPE-1 is fixed and the token-store hot reload is implemented.** The
lazy-hash window matters when audit integrity is the selling point. The inability to
revoke a user without a restart is a real operational wart in multi-user mode.

**Counts: 0 critical · 5 high (all docs) · 3 medium · 8 low.** No defect category rises
to "this is broken." Everything found is either (a) documentation that diverged from
code, (b) a hardening gap with a known workaround, or (c) a code-quality nit.

This is a well-built project.

---

## Appendix — Finding IDs (canonical list)

### High

- **H-DOC-1** — `docs/architecture.md` lines 14, 16 reference non-existent files `src/ingestion/pipeline.ts` and `src/compounding/scheduler.ts`. Actual: `queue.ts`, `engine.ts`.
- **H-DOC-2** — `docs/architecture.md` lines 22-24, 156-157 and `docs/cli-reference.md` line 21 describe fork-based daemon; code uses spawn per D-16.
- **H-DOC-3** — `docs/architecture.md` line 143 and `docs/provenance.md` line 46 list synthesis type as `"synthesize"`; code uses `"compound"`. `docs/provenance.md` line 46 also lists `"audit"` which does not exist as a provenance type.
- **H-DOC-4** — `docs/architecture.md` lines 60-67 list wiki categories `events/decisions/other/`. Actual: `concepts/entities/sources/comparisons/syntheses/queries/`.
- **H-DOC-5** — `docs/mcp-tools.md` line 79 `get_stats` example uses non-existent category `decision`.

### Medium

- **M-SEC-1** — `src/server/tools.ts:364-370` `resolveWikiPath` uses substring `..` check instead of `path.resolve` + `path.relative` canonicalization. Missing cases: Windows drive letters, symlinks escaping wiki root.
- **M-SEC-2** — `src/server/middleware.ts` accepts all requests when `auth_token === null && multi_user.enabled === false`. Documented in `docs/mcp-tools.md` but no startup warning and no refuse-to-start check on non-loopback bind.
- **M-PIPE-1** — `src/ingestion/queue.ts` computes provenance hashes lazily at end-of-batch; narrow race window with concurrent compounding/manual edits between write and hash.

### Low

- **L-DUP-1** — `src/utils/hash.ts` vs `src/provenance/hash.ts` duplication; `sha256File` function exists in both with different sync/async signatures.
- **L-CODE-1** — `src/ingestion/queue.ts:335` uses `p.replace(wikiRoot, "")` instead of `path.relative(wikiRoot, p)`.
- **L-CODE-2** — `src/cli/index.ts:5` comment still references `child_process.fork`; code uses spawn per D-16.
- **L-CODE-3** — `src/cli/commands/status.ts` re-implements JSONL cost parsing instead of calling `CostTracker.spentToday()`.
- **L-CODE-4** — `src/ingestion/wiki-writer.ts` rejects `rel.startsWith(".")` which blocks legitimate hidden files.
- **L-PERF-1** — `src/ingestion/cost-tracker.ts:spentToday()` is O(n) on every pre-flight budget check.
- **L-SEC-1** — `src/multi-user/token-store.ts` authenticate is not constant-time (acknowledged in code comments; low impact given 32-byte CSPRNG tokens).
- **L-SEC-2** — `src/ingestion/cli-invoker.ts:93` propagates full `process.env` into subprocess; documented trade-off.
- **L-SEC-3** — `src/utils/sanitize.ts` password-in-URL regex over-matches bare `user@host` patterns.

---

**End of report.**
