# Deep Verification Audit Fix Tracker
**Started:** 2026-04-11
**Status:** COMPLETE

## Progress
- [x] CRITICAL-1: Zero-hit guard indistinguishable from broken search
- [x] CRITICAL-2: CLI mode stdin write failure silently continues
- [x] CRITICAL-3: CLI mode hardcodes all cost/token metrics to zero
- [x] CRITICAL-4: Cost file read failure returns $0, bypassing budget
- [x] CRITICAL-5: Corrupted provenance chain silently resets to genesis
- [x] CRITICAL-6: Provenance fsync failure silently swallowed
- [x] CRITICAL-7: Watcher batch handler failure permanently drops files
- [x] CRITICAL-8: Empty/refused LLM response treated as successful batch
- [x] CRITICAL-9: Token store silently resets on corrupt file
- [x] CRITICAL-10: Daemon fatal errors logged to /dev/null
- [x] HIGH-1: Three heal handlers don't rebuild search index
- [x] HIGH-2: Provenance append failures swallowed across 5 call sites
- [x] HIGH-3: chokidar error handler is log-only with no recovery
- [x] HIGH-4: Unhandled rejections logged but daemon continues
- [x] HIGH-5: Approve command has no superseded-candidate detection
- [x] HIGH-6: Vocabulary enricher uses non-atomic writeFileSync
- [x] HIGH-7: Vocabulary enricher provenance hashes are synthetic/static
- [x] HIGH-8: MiniSearch rebuild has no rollback on partial failure
- [x] MEDIUM-1: failed_batches: 0 when dead-letter not configured
- [x] MEDIUM-2: get_stats health/query-metrics bare catch blocks
- [x] MEDIUM-3: Config missing silently falls back to all defaults
- [x] MEDIUM-4: Query expansion catch logs at debug level
- [x] MEDIUM-5: parsePage silently coerces all invalid frontmatter
- [x] MEDIUM-6: PID file not written atomically
- [x] MEDIUM-7: Cost tracker append failure loses entry and skips cache update
- [x] MEDIUM-8: No periodic reconciliation for missed watcher events
- [x] MEDIUM-9: Unsafe (err as Error).message cast in 12+ locations
- [x] MEDIUM-10: Lint command defaults to "api" mode on execution mode failure
- [x] LOW-1: serve.ts is a dead stub with stale message
- [x] LOW-2: sanitizeSlug can produce collisions via "untitled" fallback
- [x] LOW-3: Error messages sent to LLM as source file content
- [x] LOW-4: fileExists/dirExists return false on EACCES
- [x] LOW-5: atomicWrite orphans temp files on rename failure
- [x] LOW-6: Model router hardcoded pricing table
- [x] LOW-7: heal-handlers.ts hardcodes model_id: "claude"
- [x] LOW-8: get_index returns placeholder as success

## Fix Log
| Finding | Files Changed | Tests Added | Notes |
|---------|--------------|-------------|-------|
| CRITICAL-1 | query-engine.ts, tools.ts | 2 (query-engine-search-health.test.ts) | Search health pre-flight check |
| CRITICAL-2 | cli-invoker.ts | 0 (existing test updated) | stdinFailed flag, returns empty writtenPaths |
| CRITICAL-3 | cli-invoker.ts | 0 (existing test updated) | 4-bytes-per-token estimation |
| CRITICAL-4 | cost-tracker.ts | 0 | ENOENT-only catch, all others throw |
| CRITICAL-5 | chain.ts | 0 | Corruption detection on non-empty file with 0 valid records |
| CRITICAL-6 | chain.ts | 0 | Removed .catch(() => undefined) from fsync |
| CRITICAL-7 | watcher/index.ts | 0 | Retry with Map<string,number>, max 3, onDropped callback |
| CRITICAL-8 | queue.ts | 0 | Empty batch guard after reconcileWrittenPages |
| CRITICAL-9 | token-store.ts | 0 | .corrupt backup + logger warning on corrupt file |
| CRITICAL-10 | daemon/entry.ts | 0 | Early fallback logger init before daemon logic |
| HIGH-1 | heal-handlers.ts | 0 | search.rebuild() in healStale/healBrokenLinks/healContradiction |
| HIGH-2 | tools.ts, vocabulary-enricher.ts | 0 | provenance_gaps stat + WARN→ERROR log level |
| HIGH-3 | watcher/index.ts, tools.ts | 0 | degraded flag + isDegraded() + watcher_degraded stat |
| HIGH-4 | daemon/index.ts | 0 | unhandledRejection now calls shutdown(1) |
| HIGH-5 | approve.ts | 0 | Superseded-candidate check before writePage |
| HIGH-6 | vocabulary-enricher.ts | 0 | writeFileSync → atomicWriteSync |
| HIGH-7 | vocabulary-enricher.ts | 0 | Real prompt/response hashes for provenance |
| HIGH-8 | search.ts | 0 | Snapshot + restore on rebuild failure |
| MEDIUM-1 | tools.ts | 0 | null fallback + dead_letter_configured flag |
| MEDIUM-2 | tools.ts | 0 | Replaced bare catch {} with logged catch |
| MEDIUM-3 | config.ts | 0 | console.warn when no config found |
| MEDIUM-4 | query-expansion.ts | 0 | debug → warn log level |
| MEDIUM-5 | page.ts | 0 | Debug logging for coerced frontmatter fields |
| MEDIUM-6 | lifecycle.ts | 0 | writeFileSync → atomicWriteSync |
| MEDIUM-7 | cost-tracker.ts | 0 | Cache updated before file write |
| MEDIUM-8 | watcher/index.ts | 0 | Reconciliation timer + walkRawFiles |
| MEDIUM-9 | 16 files | 6 (errors.test.ts) | errMsg() utility + global replace |
| MEDIUM-10 | lint.ts | 0 | warn() on execution mode failure |
| LOW-1 | serve.ts | 0 | Updated docblock + user-facing messages |
| LOW-2 | store.ts | 0 (existing test updated) | untitled-<sha256_8> suffix |
| LOW-3 | prompt-builder.ts | 0 | Skip unreadable files instead of sending error text |
| LOW-4 | fs.ts | 0 | ENOENT-only catch, EACCES now throws |
| LOW-5 | fs.ts | 0 | try/finally cleanup of orphaned temp files |
| LOW-6 | model-router.ts | 0 | Warn on unknown model pricing fallback |
| LOW-7 | heal-handlers.ts | 0 | Dynamic model_id from config/modelRouter |
| LOW-8 | tools.ts | 0 | isError: true on placeholder index |

## Verification
- **All 5 gates green**: typecheck, lint, format, test, build
- **394 tests** across **44 test files** (was 386/42 pre-audit)
- **76 source files**, ~13,100 source LoC
- `grep "as Error).message" src/` → 0 production matches (1 JSDoc comment in errors.ts)
- `grep "catch {}" src/` → 0 matches
