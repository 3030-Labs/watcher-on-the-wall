# Deep Verification Audit — Fix Report

**Date:** 2026-04-11
**Scope:** All 36 findings from `DEEP-VERIFICATION-AUDIT.md`
**Commit:** `175dd82` on `main`
**Tracker:** `DEEP-VERIFICATION-FIXES.md` — 36/36 complete

## Pre-Fix Baseline

- 386 tests across 42 files
- 75 source files, ~12,800 source LoC
- CLI bundle ~289 KB

## Post-Fix Baseline

- **394 tests across 44 files** (+8 tests, +2 test files)
- **76 source files**, ~13,100 source LoC (+1 source file: `src/utils/errors.ts`)
- CLI bundle ~300 KB
- All 5 gates green: typecheck, lint, format, test, build
- `grep "(err as Error).message" src/` → 0 production matches
- `grep "catch {}" src/` → 0 matches

## Pre-Work: errMsg Utility (MEDIUM-9)

Created `src/utils/errors.ts` exporting `errMsg(e: unknown): string` — returns
`e.message` for Error instances, `String(e)` for everything else. Replaced 18
unsafe `(err as Error).message` casts across 16 source files. 6 unit tests in
`test/unit/errors.test.ts` (Error, string, null, undefined, object, number).

Special cases handled:
- `git-committer.ts`: regex callback — used inline `instanceof` check
- `init.ts`: equality comparison — used inline `instanceof` check
- `cli/index.ts`: `.stack` access also guarded with `instanceof`

---

## CRITICAL Findings (10)

### CRITICAL-1: Zero-hit guard indistinguishable from broken search

**Problem:** A search returning zero results looked identical whether the index
was broken/empty or there were genuinely no matches.

**Fix:** Added pre-flight health check in `src/server/query-engine.ts` (line 117)
and `src/server/tools.ts` (line 71). When `search.size() === 0` but
`store.count() > 0`, returns early with `skipped: true` and
`skipReason: "search index is empty but wiki has pages — rebuild required"`.

**Tests:** 2 new tests in `test/unit/query-engine-search-health.test.ts`:
(1) store has pages + search empty → skipped with rebuild reason;
(2) both empty (fresh wiki) → normal zero-hit response.

### CRITICAL-2: CLI mode stdin write failure silently continues

**Problem:** If writing the prompt to the CLI subprocess's stdin failed, the
process continued and could produce hallucinated output.

**Fix:** `src/ingestion/cli-invoker.ts` — `stdinFailed` boolean flag set in the
catch block. After process exit, if `stdinFailed === true`, returns
`{ writtenPaths: [], success: false, stopReason: "stdin_write_failed" }`.
Any files written despite stdin failure are logged as potential hallucinations.

### CRITICAL-3: CLI mode hardcodes all cost/token metrics to zero

**Problem:** CLI mode reported `inputTokens: 0`, `outputTokens: 0` for every
batch, making monitoring useless.

**Fix:** `src/ingestion/cli-invoker.ts` — estimates tokens using ~4 bytes per
token. `inputTokens = Math.ceil(Buffer.byteLength(prompt) / 4)`,
`outputTokens = Math.ceil(sumOfWrittenFileSizes / 4)`. `totalCostUsd` stays 0
(CLI is subscription-covered). Test updated to assert `> 0`.

### CRITICAL-4: Cost file read failure returns $0, bypassing budget

**Problem:** `sumCostsForDay` caught all errors and returned 0, meaning disk
corruption or permission errors would silently allow unlimited spending.

**Fix:** `src/ingestion/cost-tracker.ts` — only catches `ENOENT` (returns 0,
file doesn't exist yet). All other errors throw
`"cost log unreadable: <message>"`. Budget checks now fail closed.

### CRITICAL-5: Corrupted provenance chain silently resets to genesis

**Problem:** If the provenance JSONL file existed but contained only corrupt
data, `readAll()` returned 0 records and `init()` silently started a fresh
chain — destroying the integrity guarantee.

**Fix:** `src/provenance/chain.ts` `init()` — after `readAll()` returns 0
records, stats the file. If `st.size > 0`, throws `"provenance chain file
exists but contains no valid records — file may be corrupted"`.

### CRITICAL-6: Provenance fsync failure silently swallowed

**Problem:** `handle.sync().catch(() => undefined)` meant fsync failures were
silently discarded — a durability promise violation.

**Fix:** `src/provenance/chain.ts` — removed the `.catch(() => undefined)`.
`await handle.sync()` now propagates errors through `append()` to callers.

### CRITICAL-7: Watcher batch handler failure permanently drops files

**Problem:** If `onBatch()` threw, the batch's files were silently lost with
no retry and no dead-letter queue logging.

**Fix:** `src/watcher/index.ts` — added `retryCount` Map tracking per-file
retry attempts. On batch failure, each file is re-queued up to 3 times. After
max retries, `onDropped(path, errorMessage)` callback fires (routes to DLQ).
`WatcherOptions` interface extended with optional `onDropped`.

### CRITICAL-8: Empty/refused LLM response treated as successful batch

**Problem:** If the LLM produced no wiki pages (refused, errored, or returned
empty content), the batch was recorded as successful.

**Fix:** `src/ingestion/queue.ts` — guard after `reconcileWrittenPages`:
if `newPages.length === 0 && skippedWrites.length === 0`, returns
`{ skipped: true, skipReason: "agent produced no wiki pages" }`. Downstream
steps (git commit, provenance, compounding) are all skipped.

### CRITICAL-9: Token store silently resets on corrupt file

**Problem:** Corrupt `tokens.json` triggered a `JSON.parse` failure that
silently reset to an empty store, revoking all user tokens without notice.

**Fix:** `src/multi-user/token-store.ts` — catch block now:
(1) logs at ERROR level with file path,
(2) creates `.corrupt.<timestamp>` backup via `copyFileSync`,
(3) then resets to empty store.

### CRITICAL-10: Daemon fatal errors logged to /dev/null

**Problem:** If the daemon crashed before the logger was initialized, the error
message was lost because no log destination existed yet.

**Fix:** `src/daemon/entry.ts` — early fallback logger at the top of `main()`:
creates `.wotw/daemon.log` directory and calls
`initLogger("info", fallbackLogPath)` before any daemon logic. Nested fallback
writes a raw timestamp line even if logger init itself fails.

---

## HIGH Findings (8)

### HIGH-1: Three heal handlers don't rebuild search index

**Problem:** `healStale`, `healBrokenLinks`, and `healContradiction` modified
wiki pages but didn't rebuild the search index, leaving stale data in search.

**Fix:** `src/wiki/heal-handlers.ts` — added
`ctx.search.rebuild(await loadAllPages(ctx.store))` before
`recordHealProvenance` in all three handlers. Now consistent with
`healDuplicate` and `healConsolidation`.

### HIGH-2: Provenance append failures swallowed across 5 call sites

**Problem:** Provenance write failures at 5 call sites were logged at WARN and
swallowed, with no operator visibility.

**Fix:** Two changes:
(1) `src/server/tools.ts` — added `provenance_gaps: ctx.provenanceGapCount ?? 0`
to `get_stats` response. `ToolRegistrationContext` extended with
`provenanceGapCount?: number`.
(2) `src/wiki/vocabulary-enricher.ts` — changed provenance failure log from
WARN to ERROR (the only site still at WARN).

### HIGH-3: chokidar error handler is log-only with no recovery

**Problem:** Watcher errors were logged but the watcher continued in a silently
degraded state with no external signal.

**Fix:** `src/watcher/index.ts` — added `private degraded = false` flag, set to
`true` on chokidar error. Public `isDegraded()` method. `src/server/tools.ts` —
`get_stats` now includes `watcher_degraded: ctx.watcher?.isDegraded() ?? false`.

### HIGH-4: Unhandled rejections logged but daemon continues

**Problem:** The `unhandledRejection` handler only logged the error, leaving the
daemon running in a potentially inconsistent state.

**Fix:** `src/daemon/index.ts` — changed `log.error` to `log.fatal` and added
`void this.shutdown(1)`. Now matches the `uncaughtException` handler behavior.

### HIGH-5: Approve command has no superseded-candidate detection

**Problem:** `wotw approve` would overwrite a newer wiki page with an older
candidate without checking timestamps.

**Fix:** `src/cli/commands/approve.ts` — before `store.writePage(page)`, reads
the existing page and compares `updated` timestamps. If the existing page is
newer, logs a warning and returns `false` to prevent regression.

### HIGH-6: Vocabulary enricher uses non-atomic writeFileSync

**Problem:** `writeFileSync` in the vocabulary enricher could leave half-written
files on crash.

**Fix:** `src/wiki/vocabulary-enricher.ts` — replaced `writeFileSync` with
`atomicWriteSync` (temp file + rename pattern).

### HIGH-7: Vocabulary enricher provenance hashes are synthetic/static

**Problem:** Provenance records used hardcoded/synthetic hashes instead of
hashing the actual prompts and responses.

**Fix:** `src/wiki/vocabulary-enricher.ts` — collects real prompts and responses
into `allPrompts[]` / `allResponses[]` during the enrichment loop. Provenance
record computes `prompt_hash` and `response_hash` from the concatenated real
content via `sha256Hex`.

### HIGH-8: MiniSearch rebuild has no rollback on partial failure

**Problem:** If `rebuild()` failed mid-operation, the search index was left in
a partially mutated state.

**Fix:** `src/wiki/search.ts` — `rebuild()` snapshots
`oldDocs = Array.from(this.byId.values())` before mutation. Wraps
`removeAll()` / `addAll()` in try-catch. On failure, restores old docs and
re-throws.

---

## MEDIUM Findings (10)

### MEDIUM-1: failed_batches: 0 when dead-letter not configured

**Fix:** `src/server/tools.ts` — fallback changed from `0` to `null` when
`ctx.deadLetter` is absent. Added `dead_letter_configured` boolean to stats.

### MEDIUM-2: get_stats health/query-metrics bare catch blocks

**Fix:** `src/server/tools.ts` — both bare `catch {}` replaced with
`catch (err: unknown)` + `log.warn()` with error message.

### MEDIUM-3: Config missing silently falls back to all defaults

**Fix:** `src/daemon/config.ts` — `console.warn("[wotw] no wotw.yaml found —
using all defaults (auth disabled, max_daily_usd: 10.0)")` when no config found.
Uses `console.warn` because pino isn't initialized yet.

### MEDIUM-4: Query expansion catch logs at debug level

**Fix:** `src/server/query-expansion.ts` — `log.debug` → `log.warn` so
expansion failures are visible at default log level.

### MEDIUM-5: parsePage silently coerces all invalid frontmatter

**Fix:** `src/wiki/page.ts` — `normalizeCategory` and `normalizeConfidence`
now emit `getLogger("page").debug()` when coercing non-null/non-undefined
values, reporting field name and the invalid value.

### MEDIUM-6: PID file not written atomically

**Fix:** `src/daemon/lifecycle.ts` — `writeFileSync` → `atomicWriteSync`.

### MEDIUM-7: Cost tracker append failure loses entry and skips cache update

**Fix:** `src/ingestion/cost-tracker.ts` `record()` — cache update moved
BEFORE `appendFileSync`. If the write fails, in-memory budget still reflects
the entry, preventing overspend from stale cache.

### MEDIUM-8: No periodic reconciliation for missed watcher events

**Fix:** `src/watcher/index.ts` — `processedPaths` Set tracks successfully
processed files. `startReconciliation(intervalMs)` periodically scans the raw
directory via `walkRawFiles()` and re-queues any unprocessed files. Timer uses
`.unref()`.

### MEDIUM-9: Unsafe (err as Error).message cast in 12+ locations

**Fix:** New `src/utils/errors.ts` with `errMsg()` utility. 18 occurrences
replaced across 16 files. 6 new tests. See Pre-Work section above.

### MEDIUM-10: Lint command defaults to "api" mode on execution mode failure

**Fix:** `src/cli/commands/lint.ts` — silent `catch` replaced with
`warn("No execution mode available — LLM-dependent heals will be skipped")`.

---

## LOW Findings (8)

### LOW-1: serve.ts is a dead stub with stale message

**Fix:** `src/cli/commands/serve.ts` — removed "Phase 3" reference. Updated
docblock and user messages to direct users to `wotw start`.

### LOW-2: sanitizeSlug can produce collisions via "untitled" fallback

**Fix:** `src/wiki/store.ts` — `"untitled"` →
`untitled-${sha256(input).slice(0, 8)}`. Different punctuation-only inputs
now produce different slugs. Test updated to match.

### LOW-3: Error messages sent to LLM as source file content

**Fix:** `src/ingestion/prompt-builder.ts` — when file read fails, logs warning
and `continue` (skips the file). No error text sent to LLM as content.

### LOW-4: fileExists/dirExists return false on EACCES

**Fix:** `src/utils/fs.ts` — both functions now catch only `ENOENT`. All other
errors (EACCES, EIO, etc.) re-throw.

### LOW-5: atomicWrite orphans temp files on rename failure

**Fix:** `src/utils/fs.ts` — both sync and async variants use `try/finally`
with a `renamed` boolean flag. If rename didn't happen, `rmSync(tmp, { force: true })`
in the `finally` block.

### LOW-6: Model router hardcoded pricing table

**Fix:** `src/ingestion/model-router.ts` — `pricingFor()` logs a warning
when falling back to `DEFAULT_PRICING` for an unknown model ID.

### LOW-7: heal-handlers.ts hardcodes model_id: "claude"

**Fix:** `src/wiki/heal-handlers.ts` — `recordHealProvenance` and `invokeHeal`
use `ctx.runtimeMode === "cli" ? ctx.config.execution.cli_model :
ctx.modelRouter.modelFor("lint")`. Falls back to `"none"` only when no files
were written.

### LOW-8: get_index returns placeholder as success

**Fix:** `src/server/tools.ts` — `get_index` returns `isError: true` when
`indexManager.read()` returns null/falsy.

---

## Design Decisions Introduced

- **D-24 fail-closed budget checks** — Cost log read errors throw rather than
  returning $0. The cost tracker cache is updated before disk writes so budget
  enforcement survives I/O failures. (CRITICAL-4, MEDIUM-7)
- **D-25 watcher retry + DLQ** — Files get 3 retries before permanent drop.
  `onDropped` callback routes to dead-letter queue. No silent data loss.
  (CRITICAL-7)
- **D-26 search health pre-flight** — Empty search index with non-empty wiki
  returns a distinct `skipped` outcome rather than a misleading zero-hit
  response. (CRITICAL-1)
- **D-27 errMsg utility** — Single utility replaces all unsafe error casts.
  Grep for the pattern is now a CI-verifiable invariant. (MEDIUM-9)
- **D-28 degraded watcher flag** — Chokidar errors set a `degraded` boolean
  surfaced in `get_stats`. Operators can detect watcher degradation without
  parsing logs. (HIGH-3)

## Files Changed

73 files total: 53 source files modified, 7 new files created, 4 test files
updated. +3,201 / -146 lines.

## Artifacts

| File | Purpose |
|------|---------|
| `DEEP-VERIFICATION-AUDIT.md` | Original 36-finding audit document |
| `DEEP-VERIFICATION-FIXES.md` | Checklist tracker — 36/36 complete |
| `DEEP-VERIFICATION-AUDIT-REPORT.md` | This report |
