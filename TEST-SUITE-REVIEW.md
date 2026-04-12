# Test Suite Review

**Date:** 2026-04-11
**Scope:** 394 tests across 44 files (verified via `vitest run --reporter=json`)
**Verdict:** **NEEDS WORK** — 8 of 10 CRITICAL audit fixes have zero or insufficient regression tests

## Summary

| Category | Count |
|----------|-------|
| Total tests reviewed | 394 |
| KEEP | 339 |
| STRENGTHEN | 27 |
| REWRITE | 3 |
| DELETE | 3 |
| ADD (new tests needed) | 52 |

**Bottom line:** The test suite is structurally sound — most tests exercise real filesystem I/O, real parsers, and real production code paths. The problem is not test quality but test *coverage of audit fixes*. The Deep Verification Audit found 10 CRITICAL and 8 HIGH findings. All 36 findings were fixed in source. But only **2 of 10 CRITICALs** and **1 of 8 HIGHs** have tests that would actually catch a reversion. The fixes exist but are unguarded.

---

## Audit Cross-Reference: CRITICAL Findings

This is the most important section. For each CRITICAL finding, does a test exist that would fail if the fix were reverted?

| Finding | Fix Location | Test Exists? | Would Catch Revert? | Verdict |
|---------|-------------|-------------|---------------------|---------|
| CRITICAL-1: Zero-hit guard vs broken search | query-engine.ts:115-129 | YES: `query-engine-search-health.test.ts` | **YES** — `skipped` goes false→true, `skipReason` disappears | **COVERED** |
| CRITICAL-2: CLI stdin write failure silently continues | cli-invoker.ts:127-195 | NO | N/A | **UNTESTED** |
| CRITICAL-3: CLI mode hardcodes cost/tokens to zero | cli-invoker.ts:198-207 | PARTIAL: test asserts `inputTokens > 0` | **NO** — `toBeGreaterThan(0)` doesn't pin the formula | **WEAK** |
| CRITICAL-4: Cost file read failure returns $0 | cost-tracker.ts:32-37 | NO | N/A — ENOENT test passes with both buggy and fixed code | **UNTESTED** |
| CRITICAL-5: Corrupted chain silently resets to genesis | chain.ts:99-114 | NO | N/A | **UNTESTED** |
| CRITICAL-6: Provenance fsync failure swallowed | chain.ts:192 | NO | N/A — no test forces fsync to fail | **UNTESTED** |
| CRITICAL-7: Watcher batch failure drops files | watcher/index.ts retry logic | NO | N/A | **UNTESTED** |
| CRITICAL-8: Empty LLM response treated as success | queue.ts:284-298 | NO | N/A | **UNTESTED** |
| CRITICAL-9: Token store resets on corrupt file | token-store.ts:87-92 | PARTIAL: test #4 checks no-throw | **NO** — removing `.corrupt` backup doesn't fail any test | **PARTIAL** |
| CRITICAL-10: Daemon errors logged to /dev/null | daemon/entry.ts early logger | NO | N/A | **UNTESTED** |

## Audit Cross-Reference: HIGH Findings

| Finding | Fix Location | Test Exists? | Would Catch Revert? | Verdict |
|---------|-------------|-------------|---------------------|---------|
| HIGH-1: Heal handlers don't rebuild search | heal-handlers.ts (6 rebuild calls) | NO — tests only check `result.fixed` | **NO** — removing all `ctx.search.rebuild()` calls fails 0 tests | **UNTESTED** |
| HIGH-2: Provenance append failures swallowed | 5 call sites | NO — caller-level tests don't mock chain.append to fail | N/A | **UNTESTED** |
| HIGH-3: chokidar error = log only, no recovery | watcher/index.ts degraded flag | NO | N/A | **UNTESTED** |
| HIGH-4: Unhandled rejections don't shutdown | daemon/index.ts:186-189 | NO | N/A | **UNTESTED** |
| HIGH-5: Approve has no superseded-candidate check | approve.ts:103-116 | NO — candidates tests manually reimplement approve logic | N/A — real `approveOne()` never called | **UNTESTED** |
| HIGH-6: Vocab enricher non-atomic write | vocabulary-enricher.ts | WEAK — store test checks content, not atomicity | **NO** | **WEAK** |
| HIGH-7: Vocab enricher synthetic hashes | vocabulary-enricher.ts:204,206 | NO | N/A | **UNTESTED** |
| HIGH-8: MiniSearch rebuild no rollback | search.ts:61-76 | NO | N/A — rollback code is dead from a testing perspective | **UNTESTED** |

## Audit Cross-Reference: MEDIUM/LOW Findings (Selected)

| Finding | Test Coverage | Verdict |
|---------|-------------|---------|
| MEDIUM-3: Config missing → silent defaults | `loadConfig()` never called in tests | **UNTESTED** |
| MEDIUM-5: parsePage coerces invalid frontmatter | Partial — only string-type invalids tested | **PARTIAL** |
| MEDIUM-7: Cost append failure skips cache update | Zero coverage of append failure path | **UNTESTED** |
| MEDIUM-9: Unsafe `(err as Error).message` | `errMsg()` utility well-tested; call-site grep = separate concern | **COVERED** (utility) |
| LOW-2: sanitizeSlug collision via "untitled" | Test verifies hash suffix + different inputs diverge | **COVERED** |
| LOW-4: fileExists returns false on EACCES | Source is correct (re-throws) but no EACCES test guards it | **UNGUARDED** |
| LOW-5: atomicWrite orphans temp on rename failure | Test #13 checks success path only; finally cleanup untested | **UNGUARDED** |

---

## Per-File Review

### test/integration/compounding-skip.test.ts
**Tests:** 4 | **Subsystem:** Compounding engine skip logic

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | skips when compounding disabled | — | KEEP | Real WikiStore + CostTracker on tmpdir |
| 2 | skips when wiki < min_source_pages | — | KEEP | Asserts specific skip reason with threshold |
| 3 | skips when daily budget exhausted | — | KEEP | Real CostTracker.record() path |
| 4 | reports zero clusters when no tag meets min size | — | KEEP | Three meaningful assertions |

**Missing:** No test for `hasExistingSynthesis` skip, CLI mode cost-skip bypass, error handling during synthesis, provenance recording failure.

---

### test/integration/daemon-wsl-verification.test.ts
**Tests:** 8 | **Subsystem:** Daemon lifecycle (PID, locks)

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | writes parseable PID file | — | KEEP | |
| 2 | checkDaemonAlive returns alive=true | — | KEEP | Real `process.pid` |
| 3 | checkDaemonAlive marks dead PID stale | — | KEEP | Uses `0x7fffffff` |
| 4 | removePidFile is idempotent | — | KEEP | |
| 5 | acquires start lock under /tmp | B | STRENGTHEN | `typeof release === "function"` is type-check not behavior |
| 6 | rejects second acquisition (mutual exclusion) | — | KEEP | Core safety property |
| 7 | allows re-acquisition after release | — | KEEP | |
| 8 | reports expected platform string | C | DELETE | Tests `os.platform()`, not production code |

**Missing:** `terminateAndWait` (graceful shutdown), corrupt PID file handling, MEDIUM-6 `atomicWriteSync` fix verification.

---

### test/integration/deletion-handling.test.ts
**Tests:** 2 | **Subsystem:** Archive/orphan pipeline

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | marks affected wiki pages as orphaned + archive record | — | KEEP | 15+ assertions, gold-standard integration test |
| 2 | records archive event even when no pages affected | — | KEEP | Good boundary case |

**Missing:** Mixed add+delete batch ordering, idempotent re-orphaning, CRITICAL-7 batch failure retry.

---

### test/integration/git-committer.test.ts
**Tests:** 5 | **Subsystem:** Git operations

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | initializes git repo on fresh dir | — | KEEP | |
| 2 | stages and commits real file | — | KEEP | |
| 3 | stages only requested paths | — | KEEP | Security property |
| 4 | returns committed=false when nothing dirty | — | KEEP | |
| 5 | rejects paths outside wiki root | — | KEEP | |

**Missing:** Retry-on-lock-contention path, `buildCommitMessage` metadata formatting, `ensureGitRepo` failure.

---

### test/integration/health-report.test.ts
**Tests:** 2 | **Subsystem:** Health report orchestrator

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | produces complete report for small wiki | B | STRENGTHEN | `toBeTruthy()` on timestamp, `toBeGreaterThanOrEqual(0)` on total (vacuous) |
| 2 | report includes summary counts | B | REWRITE | All 5 assertions are type-checks: `typeof X === "number"`. Proves shape, not values. |

**Missing:** Duplicate risk integration, backlink detection, consolidation detection, provenance-based staleness scoring, source availability when raw files missing.

---

### test/integration/lint-fix.test.ts
**Tests:** 2 | **Subsystem:** Lint + heal pipeline

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | reports findings, changes nothing (no --fix) | — | KEEP | |
| 2 | fixes missing backlinks, records them | B | STRENGTHEN | `healResults.length >= 0` is vacuous (0 passes) |

**Missing:** `maxFixes` cap, LLM-dependent heals, `--json` output, HIGH-1 search rebuild verification post-heal.

---

### test/integration/mcp-server.test.ts
**Tests:** 15 | **Subsystem:** MCP HTTP server + tools

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | /healthz without auth | — | KEEP | |
| 2 | rejects /mcp without token | — | KEEP | |
| 3 | answers search tool with valid token | — | KEEP | End-to-end MCP |
| 4 | returns stats via get_stats | — | KEEP | Concrete values |
| 5 | lists pages | — | KEEP | |
| 6 | reads a page | — | KEEP | |
| 7 | rejects path with '..' | — | KEEP | Path traversal |
| 8 | rejects Windows absolute path | — | KEEP | M-SEC-1 fix |
| 9 | rejects relative-prefixed traversal | — | KEEP | M-SEC-1 fix |
| 10 | accepts valid nested path | — | KEEP | Positive control |
| 11 | refuses non-loopback without auth | — | KEEP | M-SEC-2 fix |
| 12 | starts with WARN on loopback without auth | — | KEEP | M-SEC-2 positive control |
| 13 | authenticates alice and bob independently | — | KEEP | Multi-user |
| 14 | rejects unknown token | — | KEEP | |
| 15 | rejects revoked token | — | KEEP | |

**Missing:** Rate limit trigger (429), body size limit, `query` tool, `get_index` tool, `write_page` tool, CRITICAL-1 search health check via MCP.

---

### test/integration/wiki-pipeline.test.ts
**Tests:** 4 | **Subsystem:** Full wiki pipeline

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | stores, indexes, searches, appends provenance E2E | — | KEEP | 15+ assertions, full pipeline |
| 2 | rejects paths outside wiki dir | — | KEEP | Security boundary |
| 3 | reports missing files as skipped | — | KEEP | |
| 4 | deterministic record IDs independent of insertion order | — | KEEP | Pins hash algorithm |

**Missing:** Staging mode reconciliation, chain verification with multiple records, CRITICAL-5 chain corruption, CRITICAL-8 zero-output guard.

---

### test/unit/cli-invoker.test.ts
**Tests:** 7 | **Subsystem:** CLI mode LLM invocation

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | captures stdout, detects files, reports cost | B | STRENGTHEN | `inputTokens > 0` doesn't pin formula. Should be exact value for known input. |
| 2 | non-zero exit → success=false | — | KEEP | |
| 3 | kills subprocess on timeout | — | KEEP | |
| 4 | ignores .git, node_modules, raw/ in tree diff | — | KEEP | |
| 5 | 256KB stdin without truncation | — | KEEP | |
| 6 | cancels on abort signal | — | KEEP | |
| 7 | verifies script setup is sane | B, C | DELETE | Tests `mkdtempSync`, not production code |

**Missing:** CRITICAL-2 stdin write failure (`stdinFailed` path completely untested). CRITICAL-3 token formula exact values.

---

### test/unit/config.test.ts
**Tests:** 18 | **Subsystem:** Config loading, validation, merging

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | returns defaults | B (minor) | STRENGTHEN | `wiki_root` asserted with `toBeDefined()` not exact value |
| 2-6 | merge/copy tests | — | KEEP | |
| 7-15 | validation tests | — | KEEP | Good: invalid type, negative, port range, mode, log level |
| 16-18 | resolveConfigPaths tests | — | KEEP | |

**Missing:** `loadConfig()` is never tested (MEDIUM-3). The composition function callers actually use has zero coverage.

---

### test/unit/cost-tracker.test.ts
**Tests:** 11 | **Subsystem:** Budget enforcement

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-2 | JSONL append format | — | KEEP | |
| 3 | returns 0 when log missing | D | STRENGTHEN | Tests ENOENT path but NOT EACCES path (CRITICAL-4) |
| 4-5 | date filtering, malformed lines | — | KEEP | |
| 6-11 | budget checks (daily, per-ingest, per-query) | — | KEEP | |

**Missing:** CRITICAL-4 non-ENOENT throw (e.g., `chmod 000` file → should throw, not return $0). MEDIUM-7 append failure + cache update ordering. Cache day-rollover behavior. `sumCostsForDay()` direct tests.

---

### test/unit/execution-mode.test.ts
**Tests:** 12 | **Subsystem:** Runtime mode resolution

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-12 | All execution mode paths | — | KEEP | Strongest test file in the batch. All code paths covered. |

---

### test/unit/model-router.test.ts
**Tests:** 9 | **Subsystem:** Model selection + pricing

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-9 | Pricing, model resolution, cost computation | — | KEEP | Clean, well-structured. |

---

### test/unit/dead-letter.test.ts
**Tests:** 7 | **Subsystem:** Dead-letter queue

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-7 | Disabled, record, append, coerce, corrupt, limit, clear | — | KEEP | |

**Missing:** `record()` when file write fails (graceful degradation untested).

---

### test/unit/errors.test.ts
**Tests:** 6 | **Subsystem:** errMsg utility

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-6 | Error, string, null, undefined, object, number | — | KEEP | |

**Missing:** Falsy edge cases (`0`, `false`, `""`).

---

### test/unit/wiki-page.test.ts
**Tests:** 12 | **Subsystem:** Page parse/serialize

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | parses complete page | — | KEEP | |
| 2 | defaults when frontmatter missing | D | STRENGTHEN | MEDIUM-5: doesn't verify coercion is logged |
| 3 | normalizes invalid category | — | KEEP | Only string case; no numeric/boolean/null |
| 4 | normalizes invalid confidence | — | KEEP | Same limitation |
| 5-12 | Filtering, title derive, trim, serialize, newPage | — | KEEP | |

**Missing:** `status: "orphaned"` lifecycle fields, `consolidated_into`/`superseded_by`/`rejected_at` fields, non-object frontmatter (MEDIUM-5), `parsePage` coercion logging.

---

### test/unit/wiki-search.test.ts
**Tests:** 14 | **Subsystem:** MiniSearch wrapper

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-4 | rebuild, replace, title/body search | — | KEEP | |
| 5-7 | OR combination, boost scoring | B | KEEP | Scoring fragile to MiniSearch version |
| 8 | empty query | — | KEEP | |
| 9 | limit parameter | B | STRENGTHEN | `<= 5` passes on 0 results |
| 10 | snippet | — | KEEP | |
| 11-14 | upsert, update, remove, remove unknown | — | KEEP | |

**Missing:** HIGH-8 rebuild rollback (try/catch at search.ts:61-76 is COMPLETELY untested). `SearchFilters` (domain/scope) filtering. `rebuild([])` empty array.

---

### test/unit/wiki-store.test.ts
**Tests:** 21 | **Subsystem:** WikiStore filesystem operations

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-8 | sanitizeSlug, slugFromPath | — | KEEP | LOW-2 fix well-tested |
| 9-21 | ensureLayout, pathFor, writePage, readPage, listAll, findByTitle, relativePath | — | KEEP | |

**Missing:** `listCandidates()`, `listRejected()`, `pageStat()` — all zero coverage. `candidatesDir`/`rejectedDir` layout not verified.

---

### test/unit/health-scoring.test.ts
**Tests:** 15 | **Subsystem:** Health score computation

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-14 | staleness, source availability, link health, weighted score | — | KEEP | |
| 15 | computePageHealthScore structure | B | STRENGTHEN | `>= 0` and `<= 100` is extremely loose |

**Missing:** `computeDuplicateRisk` (zero direct tests), `computeHealthReport` (155-line orchestrator, zero tests in this file), `detectMissingBacklinks`, `detectConsolidationCandidates`.

---

### test/unit/dedup-detection.test.ts
**Tests:** 4 | **Subsystem:** Union-find duplicate grouping

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-4 | Simple pair, no dupes, transitive, independent | — | KEEP | |

---

### test/unit/heal-handlers.test.ts
**Tests:** 6 | **Subsystem:** Heal dispatch

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | healStale invokes LLM | C | STRENGTHEN | Mock returns `writtenPaths: []`. Removing `ctx.search.rebuild()` would not fail this test. HIGH-1 UNTESTED. |
| 2 | healBrokenLinks invokes with tools | C | STRENGTHEN | Same HIGH-1 concern. Mock calls not reset between tests (brittle). |
| 3 | healMissingBacklinks runs without LLM | — | KEEP | `costUsd === 0` verified |
| 4 | max_fixes_per_run cap | — | KEEP | Tests cap logic |
| 5 | healDuplicate marks pages merged | C | STRENGTHEN | Doesn't verify page actually has `status: merged` |

**Missing:** `healContradiction` (ZERO tests), `healConsolidation` (partial in consolidation.test.ts), `invokeHeal` budget pre-flight, provenance recording after heal, `commitHealChanges` failure. **No test verifies search index rebuild after ANY heal operation (HIGH-1).**

---

### test/unit/consolidation.test.ts
**Tests:** 4 | **Subsystem:** Consolidation detection + heal

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | detects groups above threshold | B | REWRITE | `for` loop over groups never executes if MiniSearch returns no similar pages — all assertions pass vacuously. No `expect(groups.length > 0)`. |
| 2 | returns empty when disabled | — | KEEP | |
| 3 | no groups below threshold | — | KEEP | |
| 4 | healConsolidation marks originals | B | STRENGTHEN | Doesn't verify `status: consolidated` or `consolidated_into` on actual pages |

---

### test/unit/provenance-chain.test.ts
**Tests:** 14 | **Subsystem:** Provenance chain

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-7 | init, append, FIFO, recovery | — | KEEP | All real FS, no mocks |
| 8-11 | verify: clean, tampered id, deleted record, tampered hash | — | KEEP | Strong tamper detection |
| 12-14 | recordsFor, readRecent, signature | — | KEEP | |

**Missing:** CRITICAL-5 (init on corrupt file — the throw on `st.size > 0 && records.length === 0` is UNTESTED). CRITICAL-6 (fsync failure propagation — no mock forces `handle.sync()` to fail). `append()` failure NOT updating in-memory state. `sizeBytes()`. `readAll()` partial corruption.

---

### test/unit/provenance-footer.test.ts
**Tests:** 8 | **Subsystem:** Provenance footer sentinels

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-8 | render, strip, ensure, idempotent replace | — | KEEP | Pure functions, clean tests |

---

### test/unit/provenance-hash.test.ts
**Tests:** 16 | **Subsystem:** Hash utilities

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-16 | GENESIS_HASH, canonicalJson, sha256, sha256File, sha256Files | — | KEEP | Known test vectors, strong |

**Missing:** `sha256FileSync` (throws on missing file, untested). `sha256File` on EACCES.

---

### test/unit/fs-utils.test.ts
**Tests:** 20 | **Subsystem:** Filesystem utilities

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-20 | expandHome, resolvePath, ensureDir, atomicWrite, readTextOrNull, fileExists, dirExists, removeIfExists | — | KEEP | All real FS |

**Missing:** LOW-4 EACCES propagation test for `fileExists`/`dirExists`. LOW-5 temp file cleanup on rename failure. `readTextOrNull` on EACCES.

---

### test/unit/sanitize.test.ts
**Tests:** 7 | **Subsystem:** Secret redaction

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-7 | password-in-url: http, non-http, email false positives, report API | — | KEEP | |

**Missing:** Only 1 of 9 redaction rules tested. AWS keys, GitHub tokens, Anthropic API keys, OpenAI keys, private key blocks, JWTs, credit cards, SSNs — ALL UNTESTED. Multiple-rule interaction untested. `sanitizeWithReport` `lastIndex` reset bug untested.

---

### test/unit/token-store.test.ts
**Tests:** 19 | **Subsystem:** Multi-user token management

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-3 | load empty, existing, malformed | — | KEEP | |
| 4 | survives corrupt tokens.json | D | STRENGTHEN | CRITICAL-9: doesn't verify `.corrupt` backup created |
| 5-19 | addUser, authenticate, revoke, permissions, persistence | — | KEEP | |

---

### test/unit/query-engine.test.ts
**Tests:** 2 | **Subsystem:** Query engine zero-hit guard

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | returns 'no relevant pages' for empty wiki | — | KEEP | Real WikiStore + WikiSearch |
| 2 | returns 'no relevant pages' for unmatched query | — | KEEP | |

**Missing:** Budget exceeded path. LLM invocation failure. Provenance recording. Query expansion error fallback.

---

### test/unit/query-engine-search-health.test.ts
**Tests:** 2 | **Subsystem:** CRITICAL-1 search health pre-flight

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1 | skipped=true when store has pages but search empty | — | KEEP | **REGRESSION-PROOF for CRITICAL-1** |
| 2 | normal zero-hit when both empty | — | KEEP | False-positive guard |

---

### test/unit/query-expansion.test.ts
**Tests:** 6 | **Subsystem:** LLM-powered query expansion

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-6 | happy path, garbage response, error, disabled, code fences, non-string filter | — | KEEP | |

**Missing:** Budget exceeded guard. CLI runtime mode. Empty JSON array response.

---

### test/unit/query-metrics.test.ts
**Tests:** 9 | **Subsystem:** Zero-hit metrics + vocabulary enrichment

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-7 | computeZeroHitRate, recordQueryOutcome | — | KEEP | |
| 8 | recordQueryOutcome with empty path | B | STRENGTHEN | Only checks no-throw; doesn't verify nothing was written |
| 9 | vocabulary enrichment skips when disabled | — | KEEP | |

**Missing:** Vocabulary enricher has 264 LoC but only 1 test (disabled gate). Entire LLM enrichment loop, term application, provenance, git commit — UNTESTED.

---

### test/unit/metadata-search.test.ts
**Tests:** 8 | **Subsystem:** Frontmatter metadata + filtered search

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-7 | key_terms round-trip, domain/scope filters, key_terms searchable | — | KEEP | |
| 8 | scope filter | B | STRENGTHEN | `hits.every(...)` passes on empty array (vacuous truth) |

---

### test/unit/middleware.test.ts
**Tests:** 17 | **Subsystem:** Auth, rate limiting, proxy trust

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-17 | RateLimiter, runMiddleware, F-7 regression, XFF trust | — | KEEP | **Strongest test file in the codebase.** F-7 regression test is exemplary. |

---

### test/unit/cross-reference.test.ts
**Tests:** 13 | **Subsystem:** Bidirectional wiki link repair

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-13 | normalizeSlug, extractWikiLinks, toWikiSlug, repairBidirectionalLinks | — | KEEP | All real WikiStore on tmpdir |

---

### test/unit/candidates-workflow.test.ts
**Tests:** 8 | **Subsystem:** Approve/reject workflow

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-3 | listCandidates, listRejected | — | KEEP | |
| 4 | moves candidate to wiki category | C | STRENGTHEN | Manually reimplements approve logic — does NOT call `approveOne()` |
| 5 | approved page has correct frontmatter | C | STRENGTHEN | Same — bypasses real code |
| 6-8 | rejection metadata, body, no-reason | — | KEEP | |

**Missing:** `approveOne()` superseded-candidate detection (HIGH-5). Provenance on approve. `--all` flag. `rebuildAfterApprove`.

---

### test/unit/search-command.test.ts
**Tests:** 5 | **Subsystem:** `wotw search` CLI

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-2 | find pages, no matches | — | KEEP | |
| 3 | respects limit | B | STRENGTHEN | `<= 3` passes on 0 results |
| 4-5 | snippet content, empty wiki | — | KEEP | |

---

### test/unit/stale-command.test.ts
**Tests:** 11 | **Subsystem:** `wotw stale` CLI

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-11 | parseDuration, scoreThresholdForDuration, dashboard | — | KEEP | All solid |

---

### test/unit/staging.test.ts
**Tests:** 5 | **Subsystem:** Staging mode

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-5 | redirect to candidates, keep in category, rejection feedback | — | KEEP | Real production code exercised |

---

### test/unit/init-wizard.test.ts
**Tests:** 11 | **Subsystem:** `wotw init` wizard

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-11 | scaffold, default cwd, placeholders, config, idempotent, --force, gitignore branches, overlay | — | KEEP | One of the strongest test files |

---

### test/unit/vault-detect.test.ts
**Tests:** 10 | **Subsystem:** Obsidian vault detection

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-9 | registry, vaults, enclosing vault, open command | — | KEEP | |
| 10 | openInObsidian returns false on failure | B | KEEP | `typeof result === "boolean"` is weak but reflects env-dependent behavior |

---

### test/unit/version.test.ts
**Tests:** 2 | **Subsystem:** Version string

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-2 | matches package.json, semver format | — | KEEP | Trivial but correct |

---

### test/unit/logs-command.test.ts
**Tests:** 5 | **Subsystem:** `wotw logs` CLI

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-5 | default 20 lines, custom count, short log, missing file, invalid --lines | — | KEEP | |

---

### test/unit/lint-scheduler.test.ts
**Tests:** 6 | **Subsystem:** LintScheduler daemon subsystem

| # | Test Name | Criteria Failed | Verdict | Notes |
|---|-----------|----------------|---------|-------|
| 1-6 | disabled, startup run, interval, cached result, error, stop | — | KEEP | Proper fake timers, injectable runner |

**Missing:** `auto_fix: true` flag propagation. Double-start leaking timers.

---

## Redundancy Report

### Near-Redundant Test Groups

1. **health-report.test.ts#2 is fully redundant with #1** — Test #2 checks `typeof summary.X === "number"` for 5 fields. Test #1 already accesses all these fields with value-based assertions. DELETE test #2 or merge into #1 with real value checks.

2. **provenance-footer.test.ts#8 overlaps with #3** — Both test `source_count` in footer output. Could collapse.

3. **search-command.test.ts overlaps with wiki-search.test.ts** — Both test `WikiSearch.search()`. The search-command tests exercise the same happy-path through a thinner slice. Not strictly redundant (different test scope) but the shared setup is duplicated.

4. **config.test.ts validation tests (8-15)** — These 8 tests follow an identical pattern (build config with one invalid field → assert throw with field name). Could be a parameterized test. Not redundant per se, but could be consolidated.

### Copy-Paste Indicators

- `candidates-workflow.test.ts` tests 4-5 manually reimplement the approve logic from `approve.ts` instead of importing it. This appears to be a copy of the approve logic into the test, creating a parallel implementation that can drift from the real code.

---

## Coverage Gaps

### Source Files with ZERO Test Coverage

| File | LoC | Risk |
|------|-----|------|
| `src/cli/commands/install-hook.ts` | 127 | LOW — CLI command, fails visibly |
| `src/cli/commands/uninstall-hook.ts` | 69 | LOW |
| `src/server/resources.ts` | 64 | MEDIUM — MCP resource registration |
| `src/utils/logger.ts` | 50 | LOW — wrapper around pino |
| `src/watcher/event-classifier.ts` | 64 | MEDIUM — classification logic used by watcher |
| `src/watcher/ignore-patterns.ts` | 48 | LOW — simple pattern matching |

### Source Functions with Zero Test Coverage (Critical Paths)

| Function | File | Risk | Notes |
|----------|------|------|-------|
| `loadConfig()` | config.ts | HIGH | The actual entry point for all config loading |
| `approveOne()` | approve.ts | HIGH | Contains HIGH-5 superseded-candidate fix |
| `runVocabularyEnrichment()` (LLM path) | vocabulary-enricher.ts | HIGH | 264 LoC, only disabled-gate tested |
| `computeHealthReport()` | health.ts | MEDIUM | 155-line orchestrator |
| `healContradiction()` | heal-handlers.ts | MEDIUM | Only heal handler with zero tests |
| `terminateAndWait()` | lifecycle.ts | MEDIUM | Graceful shutdown primitive |
| `invokeIngestionAgent()` | llm-invoker.ts | HIGH | API mode LLM invocation (always mocked) |
| `DebounceBatcher` | debounce.ts | MEDIUM | Timer-based batching |
| `CompoundingEngine.synthesize()` (LLM path) | engine.ts | MEDIUM | Only skip paths tested |

### Sanitize Rule Coverage

| Rule | Tested? |
|------|---------|
| password-in-url | YES (7 tests) |
| aws-access-key | NO |
| aws-secret-key | NO |
| github-token | NO |
| anthropic-api-key | NO |
| openai-api-key | NO |
| private-key-block | NO |
| jwt | NO |
| credit-card | NO |

---

## Recommendations (Prioritized)

### P0 — CRITICAL Audit Regression Guards (add immediately)

1. **ADD: CRITICAL-5 chain corruption detection test**
   - Write 5 valid provenance records, corrupt the file (write garbage), call `chain.init()` → must throw. Currently silently resets.

2. **ADD: CRITICAL-4 cost file EACCES test**
   - Create cost-log.jsonl, `chmod 000`, call `wouldExceedDaily()` → must throw, not return `false`. Budget bypass.

3. **ADD: CRITICAL-6 fsync propagation test**
   - Mock `fileHandle.sync()` to reject, call `chain.append()` → must reject. Re-adding `.catch(() => undefined)` must fail this test.

4. **ADD: CRITICAL-2 stdin write failure test**
   - Mock/trigger stdin EPIPE, call `invokeClaudeCli()` → `success` must be `false`, `stopReason` must contain "stdin".

5. **ADD: CRITICAL-9 backup verification test**
   - Write corrupt tokens.json, call `load()` → verify `.corrupt.{timestamp}` file exists alongside original.

6. **ADD: CRITICAL-7 watcher batch retry test**
   - Mock `onBatch` to throw once then succeed. File must be processed on retry, not permanently dropped.

7. **ADD: CRITICAL-8 empty batch guard test**
   - Feed ingestion queue a batch where LLM produces zero pages → `outcome.skipped` must be `true`.

8. **STRENGTHEN: CRITICAL-3 token estimation**
   - Change `expect(result.inputTokens).toBeGreaterThan(0)` to exact expected value based on known prompt size.

### P1 — HIGH Audit Regression Guards

9. **ADD: HIGH-1 search index rebuild after heal**
   - After `healStale`/`healBrokenLinks`/`healContradiction`, call `ctx.search.search()` for updated content → must find it. Currently removing all `rebuild()` calls fails 0 tests.

10. **ADD: HIGH-8 MiniSearch rebuild rollback**
    - Build index with 10 pages, force `addAll` to throw after 3, verify old index is intact (all 10 still searchable).

11. **ADD: HIGH-5 superseded-candidate detection**
    - Create candidate at T1, write newer page to wiki at T2, run `approveOne()` → must reject or warn.

12. **ADD: healContradiction test** — only heal handler with zero coverage.

### P2 — Assertion Quality

13. **STRENGTHEN: health-report.test.ts#1** — `toBeTruthy()` → `toMatch(/^\d{4}-/)`, `>= 0` → `> 0`
14. **STRENGTHEN: lint-fix.test.ts#2** — `healResults.length >= 0` → `>= 1`
15. **STRENGTHEN: metadata-search.test.ts#8** — add `hits.length > 0` before `every()` check
16. **STRENGTHEN: search-command.test.ts#3** — add `hits.length > 0` before `<= 3` check
17. **STRENGTHEN: consolidation.test.ts#1** — add `groups.length > 0` assertion or the test is vacuous

### P3 — Missing Coverage

18. **ADD: sanitize tests for remaining 8 rules** — AWS, GitHub, Anthropic, OpenAI, private key, JWT, credit card
19. **ADD: `loadConfig()` test** — the composition entry point is untested (MEDIUM-3)
20. **ADD: vocabulary enricher LLM path test** — 264 LoC, 1 trivial test
21. **ADD: `computeHealthReport()` unit test** — 155-line orchestrator, zero direct tests
22. **ADD: LOW-4 `fileExists`/`dirExists` EACCES test** — source correct but unguarded
23. **ADD: LOW-5 atomicWrite temp cleanup on failure** — finally block untested

### P4 — Cleanup

24. **DELETE: daemon-wsl-verification.test.ts#8** — tests `os.platform()`, not production code
25. **DELETE: cli-invoker.test.ts#7** — tests `mkdtempSync`, not production code
26. **REWRITE: health-report.test.ts#2** — all type-check assertions; either add value checks or delete
27. **REWRITE: consolidation.test.ts#1** — vacuous loop; guarantee group formation or mock search results

---

## Failure Simulation Coverage

Cross-reference against Section 4 of the Deep Verification Audit:

| Scenario | Test Exists? |
|----------|-------------|
| #1: Data source HTTP 500 | NO (LLM always mocked) |
| #2: Data source 200 + empty body | NO (CRITICAL-8) |
| #3: Malformed JSON response | NO |
| #4: Data source timeout | YES (cli-invoker.test.ts#3) |
| #5: Expired auth token | YES (mcp-server.test.ts#2) |
| #6: Rate limit 429 | NO |
| #7: DNS failure | NO |
| #8: Missing env var | YES (execution-mode.test.ts) |
| #9: Search returns 0 rows | YES (query-engine-search-health.test.ts) |
| #10: File doesn't exist / 0 bytes | PARTIAL (readTextOrNull tested, watcher event drop untested) |
| #11: Partial mutation without rollback | NO |
| #12: First run, no prior state | PARTIAL (config defaults tested, no-warning gap) |
| #13: CLI binary not found | YES (execution-mode.test.ts#8,9) |
| #14: Claude 529 overloaded | NO |
| #15: Wrong schema in LLM response | PARTIAL (parsePage coercion tested) |
| #16: Corrupt provenance chain on start | NO (CRITICAL-5) |
| #17: MiniSearch partial rebuild failure | NO (HIGH-8) |
| #18: 50MB file in raw/ | NO |
| #19: Simultaneous `wotw start` | YES (daemon-wsl-verification.test.ts#6) |
| #20: Heal with provenance failure | NO (HIGH-2) |
| #21: Vault path with spaces/unicode | PARTIAL (vault-detect tests) |
| #22: Network drop mid-stream | NO |
| #23: 200 DLQ items on fresh start | NO |
| #24: Approve after source deletion | NO |
