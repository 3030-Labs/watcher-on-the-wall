# Feature Pass 001

**Date:** 2026-04-08
**Scope:** Four product-surface features plus pre-release documentation.
**Baseline:** `watcher-on-the-wall` v0.1.0 post-audit (231 tests, 20 test files).
**Outcome:** All 5 quality gates green. 251 tests across 24 files (Δ +20).

---

## Features shipped

| # | Feature | Summary | Key files |
|---|---------|---------|-----------|
| 1 | Periodic background lint | New `LintScheduler` DaemonSubsystem runs the same structural sweep as `wotw lint` on a timer. Cheap no-op when `lint.schedule_enabled: false` (the default). `unref()`'d interval never holds the daemon open. Clean sweeps log INFO, sweeps with issues log WARN so they surface in `wotw logs`. Injectable `runner` option for tests. | `src/daemon/lint-scheduler.ts` · `src/daemon/entry.ts` · `src/daemon/config.ts` (`lint.schedule_enabled`, `lint.interval_hours`) · `test/unit/lint-scheduler.test.ts` |
| 2 | Deletion handling (archive) | New `"archive"` provenance operation type. Watcher emits `deletedPaths` on the batch; queue walks the chain to find every wiki page whose `source_files` included the deleted raw path, rewrites frontmatter to `status: orphaned` + `orphaned_at` + `orphaned_source`, and appends an archive record with `source_hashes: ["deleted"]`, `model_id: "none"`. **Wiki files are never deleted.** Mixed add+delete batches run adds first, archives second, in one queue tick. Orphan count surfaced in `wotw lint`, `wotw status`, and `get_stats`. | `src/ingestion/queue.ts` (archiveDeletedSources + process short-circuit) · `src/watcher/index.ts` · `src/watcher/debounce.ts` · `src/wiki/page.ts` (orphan fields) · `src/utils/types.ts` (OperationType) · `test/integration/deletion-handling.test.ts` |
| 3 | Observability (`wotw logs` + banner) | New `wotw logs` command tails `daemon.log_file` with a default "last 20 lines" mode and a `-f`/`--follow` streaming mode. Follow uses `watchFile` (250ms poll) for WSL/inotify-flaky environments and handles log rotation via size-shrink detection. Daemon startup now logs a single INFO banner with runtime mode, MCP URL, wiki root, dead-letter status, and lint schedule status. | `src/cli/commands/logs.ts` · `src/cli/index.ts` (registration) · `src/daemon/entry.ts` (banner) · `test/unit/logs-command.test.ts` |
| 4 | Dead-letter queue | New `DeadLetterQueue` class persists permanently-failed ingestion batches as JSONL (`timestamp`, `batch_id`, `files`, `reason`, `mode`, `error`, `stack?`, `retry: false`). Empty-path config disables (every write is a no-op). Wired into `IngestionQueue` catch blocks and threaded through to the MCP server. Count surfaced in `wotw status` and `get_stats`. Survives malformed ledger lines in `list()` (skips); `count()` is a line count. Idempotent `clear()`. | `src/ingestion/dead-letter.ts` · `src/ingestion/queue.ts` · `src/daemon/entry.ts` · `src/cli/commands/status.ts` · `src/server/tools.ts` (`get_stats`) · `src/server/index.ts` · `src/daemon/config.ts` (`ingestion.dead_letter_file`) · `test/unit/dead-letter.test.ts` |

---

## Documentation

**New files at repo root:**

- `CONTRIBUTING.md` — dev setup, quality gates, code standards, project layout, PR bar.
- `SECURITY.md` — supported versions, vulnerability reporting, in-scope/out-of-scope, deployment hardening checklist, cryptographic details.
- `ROADMAP.md` — Shipped / In flight / Planned / Won't build buckets with rationale for each.

**Updates to `docs/`:**

- `docs/configuration.md` — new `lint:` block and `ingestion.dead_letter_file` documented in the schema and in a new "Feature notes" subsection.
- `docs/cli-reference.md` — `wotw logs` subsection (flags, follow semantics, rotation handling, exit on missing file); `wotw status` description expanded to mention orphan count and failed-batch count.
- `docs/architecture.md` — subsystem table now lists `lint-scheduler` and `dead-letter`; new "Deletions", "Dead-letter queue", and "Periodic lint" subsections in the Data Flow section.
- `docs/provenance.md` — `type` enum updated to include `"archive"`; new "Archive records" section with the full record shape, sentinel semantics (`source_hashes: ["deleted"]`, `model_id: "none"`), and the no-delete-on-disk guarantee.
- `docs/mcp-tools.md` — `get_stats` output schema now shows `orphaned_pages` and `failed_batches`.

---

## Quality gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | ✅ clean |
| Lint | `pnpm lint` | ✅ clean (0 errors, 0 warnings) |
| Format | `pnpm format:check` | ✅ clean |
| Tests | `pnpm test` | ✅ **251 passed / 251** (24 files) |
| Build | `pnpm build` | ✅ tsup success — `dist/cli/index.js` 199.67 KB, `dist/daemon/entry.js` 140.23 KB, `dist/index.js` 20.89 KB |

### Test count delta

| | Files | Tests |
|---|---|---|
| Pre-pass baseline | 20 | 231 |
| Post-pass total | 24 | 251 |
| **Delta** | **+4** | **+20** |

New test files added in this pass:

- `test/unit/lint-scheduler.test.ts` — 6 tests (vi.useFakeTimers; disabled state, startup run, interval tick, cached result, error handling, stop clears interval)
- `test/unit/dead-letter.test.ts` — 7 tests (disabled path, single JSONL line, multiple records, error coercion, corrupt-ledger survival, list limit, idempotent clear)
- `test/integration/deletion-handling.test.ts` — 2 tests (full archive pipeline end-to-end + chain verification; archive-with-no-affected-pages)
- `test/unit/logs-command.test.ts` — 5 tests (default 20 lines, explicit `--lines`, short log, missing file warning, invalid `--lines` exit)

---

## Minor fixes during the pass

- **Lint cleanups:** removed unused `writeFileSync` import in `test/integration/deletion-handling.test.ts`, removed two stale `eslint-disable` directives (`no-constant-condition` in `src/cli/commands/logs.ts`, `@typescript-eslint/no-explicit-any` in `test/unit/logs-command.test.ts`).
- **Formatter:** prettier auto-formatted `src/cli/commands/logs.ts`, `src/daemon/lint-scheduler.ts`, `src/watcher/index.ts`, `test/unit/dead-letter.test.ts` on first `pnpm format` run.
- **Scheduler test fix:** the three "runs once" / "fires after interval" / "stop clears" tests were incorrectly calling `vi.runOnlyPendingTimersAsync()` after `start()`, which fired the `setInterval` tick and double-counted. Since `runOnce()` calls the runner synchronously before its first `await`, the runner is guaranteed to have been called exactly once by the time `start()` returns — no timer advance is needed. Tests now assert directly.

---

## Verification notes

- **Scheduler `unref()`.** Manually verified that `setInterval(...).unref()` is called in `LintScheduler.start()`. The daemon's own check-interval remains the keep-alive.
- **Archive never deletes.** `test/integration/deletion-handling.test.ts` asserts `existsSync(hashChains.path) === true` and `existsSync(merkle.path) === true` after the archive pass — explicit regression guard against any future refactor that might try to `rm()` orphaned pages.
- **Chain still verifies after archive.** Same integration test asserts `chain.verify().ok === true` after the archive append, confirming the canonical JSON + forward-folding hash semantics handle the new record type without special-casing.
- **Dead-letter empty-path safety.** `test/unit/dead-letter.test.ts` covers the disabled path with `new DeadLetterQueue({ path: "" })` and asserts `enabled === false`, `count() === 0`, `list() === []` without any filesystem touches.
- **`wotw logs` missing file UX.** `test/unit/logs-command.test.ts` asserts the command exits 0 with a "no log file at …" message when the configured log file doesn't exist — operators running the command before `wotw start` for the first time don't see an error.
- **No-auth safety rail (regression check).** The Feature 3 banner does not bypass the existing no-auth safety rail in `src/server/index.ts`; the rail still logs WARN + refuses to start on non-loopback bind with no auth token.

---

## Ready for release

All four features are structurally complete with tests and docs.
Pre-release documentation is in place. All five quality gates are
green. The repo is ready for a 0.1.1 cut (CHANGELOG update is a
separate commit and not part of this feature pass).
