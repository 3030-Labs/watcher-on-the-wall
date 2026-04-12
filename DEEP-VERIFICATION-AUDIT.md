# Deep Verification Audit Report: watcher-on-the-wall

**Auditor:** Adversarial Code Auditor (Claude Opus 4.6)
**Date:** 2026-04-11
**Scope:** All 75 source files (~12,800 LoC), 42 test files (386 tests)
**Verdict:** **🔴 FAIL**

---

## 1. Code Inventory

### Data Sources
- **File system**: `raw/` directory (user-dropped source files), `wiki/` directory (derived pages), `provenance-chain.jsonl`, `cost-log.jsonl`, `wotw.yaml` config, `tokens.json`, `failed-batches.jsonl` (DLQ), query log JSONL, PID file, lock file, `.obsidian/obsidian.json` registry
- **LLM APIs**: Claude Agent SDK (API mode), `claude` CLI binary (CLI mode) — ingestion, query, compounding, healing, vocabulary enrichment, query expansion
- **Environment variables**: `ANTHROPIC_API_KEY`, `WOTW_DAEMON_CHILD`, `WOTW_DEBUG`, `APPDATA`, `XDG_CONFIG_HOME`
- **CLI arguments**: All `wotw` subcommands, `--config`, `--auto-approve`, `--foreground`, `--fix`, `--all`
- **Network**: MCP HTTP server on `127.0.0.1:8787`, MCP SDK transport

### Data Sinks
- **Wiki files**: `wiki/<category>/*.md` (atomic write), `wiki/candidates/*.md`, `wiki/index.md`
- **Provenance chain**: `provenance-chain.jsonl` (append-only, mutex-guarded)
- **Cost log**: `cost-log.jsonl` (append-only)
- **Dead-letter queue**: `failed-batches.jsonl` (append-only)
- **Query log**: query metrics JSONL (append-only)
- **Git commits**: via `simple-git` library
- **MCP responses**: JSON-RPC over HTTP to connected clients
- **CLI output**: stdout/stderr to terminal
- **PID file**: JSON with pid + started_at
- **Pino logs**: file or stdout

### Trust Boundaries
- **MCP client requests**: HTTP from any local process (or remote if auth disabled)
- **LLM responses**: Claude's output (text, tool calls, structured data) — treated as trusted after minimal validation
- **File system content**: `raw/` files from users, wiki pages (may be hand-edited), config files
- **CLI binary stdout**: Entire stdout is consumed as `finalText` with zero validation
- **chokidar events**: File system notifications (can be missed under load)

### Error Channels
- **try/catch blocks**: 67 identified across the codebase
- **Bare `catch {}` (no logging)**: 28 instances
- **`.catch(() => undefined)`**: 3 instances (chain.ts fsync, mcp-client.ts cleanup×2)
- **`void` fire-and-forget**: 9 instances
- **Process-level**: `uncaughtException` handler (triggers shutdown), `unhandledRejection` handler (log-only, **does NOT shutdown**)

---

## 2. Findings

### CRITICAL Findings

> **CRITICAL-1 — Zero-hit guard indistinguishable from broken search**
> **Location:** `src/server/query-engine.ts:118-131`
> **What happens:** When the BM25 search returns zero hits, the query tool returns `{ skipped: false, answer: "No relevant wiki pages found..." }` as a successful MCP response. A broken/empty/stale search index produces the identical response shape.
> **Why it's dangerous:** An MCP client (Claude Code, Claude Desktop) cannot programmatically distinguish "genuinely no matches" from "search subsystem is broken." Users receive confident "no relevant pages" answers when the real problem is a corrupted index. Priority 4 — looks "fine" while being fundamentally broken.
> **Priority level violated:** 4
> **Fix:** Add a pre-flight check `if (this.opts.search.size() === 0 && this.opts.store.count() > 0)` that returns `{ skipped: true, skipReason: "search index is empty but wiki has pages — rebuild required" }`. The `search` MCP tool should similarly check `search.size() vs store.count()` and annotate the response when they diverge.
> **Test case:** Build a wiki with 10 pages, then call `search.removeAll()` without `addAll()`. Query "anything" → should return `skipped: true` with a diagnostic, not "no relevant pages found."

> **CRITICAL-2 — CLI mode stdin write failure silently continues**
> **Location:** `src/ingestion/cli-invoker.ts:127-132`
> **What happens:** If `child.stdin.write(opts.userPrompt)` throws (EPIPE), the catch logs a warning and continues. The CLI subprocess runs with NO input prompt. The function collects whatever stdout the CLI produces, diffs the file tree, and returns a seemingly-valid `InvokeResult`. The caller has no way to detect the prompt was never delivered.
> **Why it's dangerous:** The ingestion pipeline believes it processed a batch when the LLM never received the source material. Wiki pages may be written based on whatever the LLM hallucinated with no context. Priority 4 — successful-looking result from a completely broken invocation.
> **Priority level violated:** 4
> **Fix:** After the catch, set a `stdinFailed = true` flag. In the return block, if `stdinFailed && writtenPaths.length === 0`, set `success = false` and `stopReason = "stdin_write_failed"`. If `stdinFailed && writtenPaths.length > 0`, log at ERROR level — the agent wrote files without receiving the prompt.
> **Test case:** Mock `child.stdin.write` to throw EPIPE → `InvokeResult.success` should be `false`, `stopReason` should contain "stdin".

> **CRITICAL-3 — CLI mode hardcodes all cost/token metrics to zero**
> **Location:** `src/ingestion/cli-invoker.ts:178-185`
> **What happens:** Every CLI-mode invocation returns `totalCostUsd: 0, inputTokens: 0, outputTokens: 0, numTurns: 0, sessionId: null`. The cost tracker records $0. Budget enforcement via `wouldExceedDaily()` is completely non-functional — CLI mode has unlimited spend with no guardrail.
> **Why it's dangerous:** A user who configures `max_daily_usd: 5.0` expects their spend to be capped. In CLI mode, the budget check always passes because recorded cost is always $0. Priority 4 — budget enforcement silently disabled.
> **Priority level violated:** 4
> **Fix:** For CLI mode, use the model router's `computeCost(model, estimatedInputTokens, estimatedOutputTokens)` with token estimates based on prompt size and output file sizes to record an approximate cost. Alternatively, clearly log a WARNING on every CLI-mode batch: "cost tracking unavailable in CLI mode — budget guardrails are not enforced."
> **Test case:** Configure `max_daily_usd: 0.01`. Run 100 CLI-mode batches. Expected: batches should be rejected after the first few. Actual: all 100 succeed with $0 recorded.

> **CRITICAL-4 — Cost file read failure returns $0, bypassing budget**
> **Location:** `src/ingestion/cost-tracker.ts:30-33`
> **What happens:** `sumCostsForDay` catches ALL errors from `readFileSync` (not just ENOENT) and returns 0. If the cost file exists but is unreadable (EACCES, corruption), `wouldExceedDaily()` thinks $0 has been spent and allows unlimited spending.
> **Why it's dangerous:** A permission change on the cost log file silently disables all budget enforcement. Priority 4 — looks like "$0 spent" when the real state is "unknown."
> **Priority level violated:** 4
> **Fix:** Catch only ENOENT (file doesn't exist yet → $0 is correct). Re-throw EACCES, EIO, and all other errors. Add a `try { accessSync(trackFile, constants.R_OK) } catch { throw new Error("cost log unreadable") }` guard.
> **Test case:** Create cost-log.jsonl with `chmod 000`. Call `wouldExceedDaily(0.01)` → should throw "cost log unreadable", not return `false`.

> **CRITICAL-5 — Corrupted provenance chain silently resets to genesis**
> **Location:** `src/provenance/chain.ts:88-107`
> **What happens:** On `init()`, if the chain file exists but ALL lines are malformed JSON, `readAll()` returns an empty array (each line is logged at `warn` and skipped). `init()` then sets `nextSeq=1` and `lastChainHash=GENESIS_HASH`. New records are appended starting from seq 1, making the entire prior history unverifiable and the chain effectively forked.
> **Why it's dangerous:** A single corrupted byte in the chain file can cause the system to silently start a new chain, losing the entire audit history. The daemon starts normally, new provenance records look valid, and `wotw audit` on the post-corruption portion passes. Priority 4 — audit trail silently destroyed.
> **Priority level violated:** 4
> **Fix:** In `init()`, after `readAll()`, if the file has non-zero size but `records.length === 0`, throw `new Error("provenance chain file exists but contains no valid records — file may be corrupted")`. Also, if `records.length < lineCount` (some lines were skipped), log at ERROR and optionally throw based on config `provenance.strict_init: true`.
> **Test case:** Write 5 valid provenance records, then corrupt byte 10 of the file. Call `chain.init()` → should throw, not silently reset.

> **CRITICAL-6 — Provenance fsync failure silently swallowed**
> **Location:** `src/provenance/chain.ts:176`
> **What happens:** `await handle.sync().catch(() => undefined)` — if fsync fails, the error is swallowed. The in-memory state is updated (seq counter, chain hash) as though the write is durable. On a power loss, the record may be lost, creating a gap in the chain.
> **Why it's dangerous:** The provenance chain is the tamper-evident audit trail. A "successful" append that isn't durable violates the core invariant. Priority 4 — caller believes the record is persisted when it may not be.
> **Priority level violated:** 4
> **Fix:** Remove the `.catch(() => undefined)`. Let fsync failures propagate. The caller (queue.ts) already has a try/catch around provenance append that logs and continues — that's the right place to handle it, not inside the chain itself.
> **Test case:** Mock `fileHandle.sync()` to reject. Call `chain.append(record)` → should reject, not resolve successfully.

> **CRITICAL-7 — Watcher batch handler failure permanently drops files**
> **Location:** `src/watcher/index.ts:183-187`
> **What happens:** If `this.opts.onBatch(batch)` throws, the catch block logs the error and returns. The files in the batch have already been cleared from the debounce batcher's pending set. They are never re-queued and never retried. The raw files still exist on disk but will never be processed unless the daemon is restarted.
> **Why it's dangerous:** A transient ingestion failure (API timeout, budget check race, etc.) permanently loses files from the processing pipeline. The files remain in `raw/` but are invisible to the watcher (chokidar already emitted their events). Priority 4 — files silently abandoned.
> **Priority level violated:** 4
> **Fix:** On batch failure, re-add the failed paths to the debounce batcher (e.g., `for (const p of batch.paths) this.batcher.add(p, "update")`). Add a retry counter per path to prevent infinite retry loops. After N retries, send to DLQ.
> **Test case:** Mock `onBatch` to throw once, then succeed. Drop a file in `raw/`. Expected: file is processed on second attempt. Actual: file is permanently dropped.

> **CRITICAL-8 — Empty/refused LLM response treated as successful batch**
> **Location:** `src/ingestion/queue.ts:274-278, 296-310`
> **What happens:** If the LLM writes zero files (empty response, refusal, malformed output), `writtenPaths` is `[]`, `newPages` is `[]`, and the batch continues through cross-ref repair, index rebuild, cost logging, git commit, and provenance recording — all operating on zero pages. The outcome reports `skipped: false, pagesWritten: 0`. No error, no warning.
> **Why it's dangerous:** A batch that produced nothing is recorded as successful. The cost is consumed. The provenance chain records it as a valid ingestion. The user's raw files appear "processed" but no wiki content was created. Priority 4 — success-shaped outcome for a do-nothing batch.
> **Priority level violated:** 4
> **Fix:** After `reconcileWrittenPages`, add: `if (newPages.length === 0 && skippedWrites.length === 0) { log.warn({ batchId }, "agent produced zero pages"); return { ...outcome, skipped: true, skipReason: "agent produced no wiki pages" }; }`. This makes zero-output explicitly visible as a skip.
> **Test case:** Feed the ingestion queue a batch where the LLM returns a refusal ("I cannot process this content"). Expected: `skipped: true`. Actual: `skipped: false, pagesWritten: 0`.

> **CRITICAL-9 — Token store silently resets on corrupt file, then overwrites evidence**
> **Location:** `src/multi-user/token-store.ts:79-91`
> **What happens:** If `tokens.json` contains invalid JSON, the catch block sets `this.tokens = new Map()` and returns — no logging, no warning. All existing user tokens become invalid. The next `save()` call overwrites the corrupt file with an empty token store, destroying the evidence of corruption.
> **Why it's dangerous:** A disk error that corrupts one byte of `tokens.json` silently invalidates all API tokens with no alert. The original file is overwritten on next mutation. Priority 4 — all authentication silently wiped.
> **Priority level violated:** 4
> **Fix:** Log at ERROR level with the file path: `log.error({ path: this.file }, "token store file is corrupt — starting with empty store")`. Before overwriting, copy the corrupt file to `${this.file}.corrupt.${Date.now()}` for forensic recovery. Consider refusing to start if the file exists but can't be parsed (fail loud).
> **Test case:** Write invalid JSON to `tokens.json`. Call `load()`. Expected: ERROR log + backup copy created. Actual: silent reset, no log, no backup.

> **CRITICAL-10 — Daemon fatal errors logged to /dev/null**
> **Location:** `src/daemon/entry.ts:165-169`
> **What happens:** The daemon runs with `stdio: 'ignore'`. If the outer try/catch fires (any startup error), `getLogger("daemon-entry")` auto-initializes a stdout logger (since `initLogger` hasn't run yet or failed). That stdout goes to `/dev/null`. The fatal error is completely invisible.
> **Why it's dangerous:** The daemon crashes on startup and the operator has zero diagnostic information. No log file, no stderr, no indication of what went wrong. Priority 4 — silent crash with no forensics.
> **Priority level violated:** 4
> **Fix:** Before the main try block, initialize the logger to a known file path: `initLogger("info", join(process.cwd(), ".wotw", "daemon.log"))`. If that fails, write to a hardcoded fallback path. Ensure the catch block's logger writes to file, not stdout.
> **Test case:** Set an invalid `wiki_root` in config (e.g., `/nonexistent/path`). Start the daemon. Check for a log file with the error. Expected: error in log file. Actual: nothing anywhere.

### HIGH Findings

> **HIGH-1 — Three heal handlers don't rebuild search index**
> **Location:** `src/wiki/heal-handlers.ts` — `healStale` (lines 48-85), `healBrokenLinks` (lines 151-190), `healContradiction` (lines 257-299)
> **What happens:** After these heal handlers mutate wiki pages on disk, the MiniSearch index is NOT rebuilt. The search index contains the old pre-heal content. Queries return stale snippets and potentially stale relevance rankings until the next full daemon restart or `rebuild()` call from another code path.
> **Why it's dangerous:** Users asking questions about healed pages get answers from the pre-heal content. The healing is silently ineffective for query consumers. Priority 2→4 gap: the heal was disclosed to the CLI user but the stale search is invisible.
> **Fix:** Add `ctx.search.rebuild(await loadAllPages(ctx.store))` after the page writes in each of these three handlers, matching the pattern already used by `healDuplicate`, `healMissingBacklinks`, and `healConsolidation`.
> **Test case:** Heal a stale page, then immediately search for its updated content → should find the new version, not the stale one.

> **HIGH-2 — Provenance append failures swallowed across 5 call sites**
> **Location:** `src/ingestion/queue.ts:344-347`, `src/ingestion/queue.ts:487-489`, `src/server/query-engine.ts:201-203`, `src/wiki/heal-handlers.ts:497-499`, `src/wiki/vocabulary-enricher.ts:216-217`
> **What happens:** All five sites catch provenance append errors, log them, and continue. The calling operation reports success. Wiki mutations reach disk and get git-committed without provenance records.
> **Why it's dangerous:** The provenance chain is the tamper-evident audit trail. Silent gaps mean `wotw audit` passes on the post-gap portion but the actual audit history is incomplete. An auditor cannot detect the missing records.
> **Fix:** At minimum, add a `provenanceGapCount` counter to the daemon's health metrics and surface it in `get_stats`. Better: make provenance failures return a distinguishable outcome (e.g., `outcome.provenanceFailed = true`) so the CLI can surface it.
> **Test case:** Mock `chain.append` to throw. Run an ingestion batch. Check `get_stats` → should report `provenance_gaps: 1`.

> **HIGH-3 — chokidar error handler is log-only with no recovery**
> **Location:** `src/watcher/index.ts:113-115`
> **What happens:** If chokidar loses its inotify handles (ENOSPC on `/proc/sys/fs/inotify/max_user_watches`, watched directory deleted, etc.), the error is logged and the daemon continues running. The watcher receives no more events. No health check, no recovery, no periodic reconciliation scan.
> **Why it's dangerous:** The daemon reports itself as healthy (PID alive, MCP server responding) while being completely deaf to file changes. New files dropped in `raw/` are permanently ignored until manual restart.
> **Fix:** On chokidar `error` event, set a `watcherDegraded: true` flag. Surface it in `get_stats` and `wotw status`. Consider implementing a periodic full-directory scan (every N minutes) that compares current `raw/` contents against known-processed files.
> **Test case:** Emit a synthetic `error` event on the chokidar instance. Check `get_stats` → should report `watcher_degraded: true`.

> **HIGH-4 — Unhandled rejections logged but daemon continues**
> **Location:** `src/daemon/index.ts:186-189`
> **What happens:** Unlike `uncaughtException` which triggers `shutdown(1)`, `unhandledRejection` only logs and continues. A corrupt state from a rejected promise propagates silently.
> **Why it's dangerous:** An unhandled rejection in the ingestion pipeline, search index, or provenance chain leaves the daemon in an undefined state. It continues serving MCP requests and processing files with potentially corrupted in-memory state.
> **Fix:** Treat unhandled rejections the same as uncaught exceptions: `void this.shutdown(1)`. This matches Node.js's own trajectory (unhandled rejections terminate the process in newer Node versions).
> **Test case:** Create an unhandled rejection inside the daemon. Expected: daemon shuts down. Actual: daemon continues with a log line.

> **HIGH-5 — Approve command has no superseded-candidate detection**
> **Location:** `src/cli/commands/approve.ts:91-138`
> **What happens:** `approveOne` reads a candidate, parses it, and writes it to `wiki/` via `store.writePage(page)` with no check whether a newer version already exists. If the daemon re-ingested the same source file between candidate creation and approval, the stale candidate silently overwrites the newer version.
> **Why it's dangerous:** User approves what they believe is the latest version. The actual latest version is silently reverted to an older draft. Wiki content degrades without any indication.
> **Fix:** Before `store.writePage`, check if the destination file exists and compare `updated` timestamps or content hashes. If the existing file is newer, prompt the user or abort with a conflict message.
> **Test case:** Create a candidate at T1. Have the daemon write a newer version to `wiki/` at T2. Run `wotw approve`. Expected: conflict error. Actual: T1 version silently overwrites T2 version.

> **HIGH-6 — Vocabulary enricher uses non-atomic writeFileSync**
> **Location:** `src/wiki/vocabulary-enricher.ts:173`
> **What happens:** `writeFileSync(absPath, serializePage(page), "utf8")` — direct in-place write. Every other write in the codebase uses `atomicWrite` (temp file + rename). If the process crashes mid-write, the file is corrupted.
> **Why it's dangerous:** A corrupted wiki page file cannot be parsed by `parsePage`, causing it to be silently excluded from all wiki operations (search, health, index, cross-references). The page becomes a zombie file.
> **Fix:** Replace `writeFileSync(absPath, serializePage(page), "utf8")` with `atomicWriteSync(absPath, serializePage(page))`.
> **Test case:** Kill the process during a vocabulary enrichment write. Read the file → should be either the old version or the new version, never a partial write.

> **HIGH-7 — Vocabulary enricher provenance hashes are synthetic/static**
> **Location:** `src/wiki/vocabulary-enricher.ts:204,206`
> **What happens:** `prompt_hash: sha256Hex("vocabulary-enrichment")` and `response_hash: sha256Hex(\`enriched-${enrichedPages.size}\`)`. Every enrichment run produces the same `prompt_hash`. Two runs enriching the same number of pages produce the same `response_hash`.
> **Why it's dangerous:** Provenance records are supposed to fingerprint the actual LLM interaction. These synthetic hashes make it impossible to audit what was actually asked/answered. The provenance chain records fake content-addressable hashes.
> **Fix:** Hash the actual prompts sent to the LLM (concatenated) for `prompt_hash`. Hash the actual LLM responses (concatenated) for `response_hash`.
> **Test case:** Run two enrichment passes with different queries. Compare provenance records → `prompt_hash` should differ. Currently: identical.

> **HIGH-8 — MiniSearch rebuild has no rollback on partial failure**
> **Location:** `src/wiki/search.ts:56-62`
> **What happens:** `rebuild()` calls `this.engine.removeAll()` then `this.byId.clear()` then `this.engine.addAll(docs)`. If `addAll` fails partway, the index is partially populated with no way to roll back to the previous state.
> **Why it's dangerous:** All pages that were in the index before the rebuild are now invisible to search until the next successful rebuild. Combined with CRITICAL-1, this creates a silent search degradation.
> **Fix:** Build the new MiniSearch instance in a separate variable, then swap atomically: `const newEngine = new MiniSearch(opts); newEngine.addAll(docs); this.engine = newEngine; this.byId = newByIdMap;`.
> **Test case:** Mock `addAll` to throw after indexing 3 of 10 docs. The old index should still be intact.

### MEDIUM Findings

> **MEDIUM-1 — `failed_batches: 0` when dead-letter not configured**
> **Location:** `src/server/tools.ts:231`
> **What happens:** `ctx.deadLetter ? await ctx.deadLetter.count() : 0` — when dead-letter is null, reports 0 failures. A monitoring dashboard cannot distinguish "no failures" from "failure tracking disabled."
> **Fix:** Return `failed_batches: null` when `ctx.deadLetter` is null, or add a `dead_letter_configured: boolean` field.

> **MEDIUM-2 — `get_stats` health/query-metrics bare catch blocks**
> **Location:** `src/server/tools.ts:260-262, 281-283`
> **What happens:** Health computation or query metrics failure → bare `catch {}`. The `health` and `query_health` keys are simply absent from the response. Three states (failure/empty/no-pages) are indistinguishable.
> **Fix:** Log at `warn` and include `health_error: true` or `query_health_error: true` in the response when the catch fires.

> **MEDIUM-3 — Config missing silently falls back to all defaults**
> **Location:** `src/daemon/config.ts:143-145`
> **What happens:** If cosmiconfig finds no `wotw.yaml`, returns all defaults with `path: null`. No log, no warning. The daemon starts with `auth_token: null` (no auth), `max_daily_usd: 10.0` ($10/day), `compounding.enabled: true`, `runtimeMode: "api"`.
> **Fix:** Log at `warn` when no config file is found and defaults are used. Consider requiring an explicit `--defaults` flag or `wotw init` before first start.

> **MEDIUM-4 — Query expansion catch logs at debug level**
> **Location:** `src/server/query-expansion.ts:121-123`
> **What happens:** Network failures and LLM errors during query expansion are logged at `debug` level (invisible in production) and the query silently falls back to the original terms with `costUsd: 0` — even though the LLM call may have already been billed.
> **Fix:** Log at `warn`. Propagate the actual `costUsd` from the failed call.

> **MEDIUM-5 — `parsePage` silently coerces all invalid frontmatter**
> **Location:** `src/wiki/page.ts:172-192`
> **What happens:** Invalid category → `"concept"`. Invalid confidence → `"medium"`. Unknown status → `null`. Non-array tags/sources/related → `[]`. No logging, no warning. A page with `category: "foobar"` is silently treated as a concept.
> **Fix:** Log at `debug` when coercion occurs. Consider adding a `coerced_fields: string[]` array to the parsed page for downstream awareness.

> **MEDIUM-6 — PID file not written atomically**
> **Location:** `src/daemon/lifecycle.ts:25`
> **What happens:** Plain `writeFileSync`. Crash mid-write → corrupt PID file → `readPidFile` returns `null` → system thinks no daemon is running → allows second instance.
> **Fix:** Use `atomicWriteSync` for PID file writes.

> **MEDIUM-7 — Cost tracker append failure loses entry and skips cache update**
> **Location:** `src/ingestion/cost-tracker.ts:87-92`
> **What happens:** If `appendFileSync` throws, the catch returns early, skipping the in-memory cache update (lines 96-109). The next `spentToday()` call returns the cached (stale) total that doesn't include the failed entry. Budget undercount.
> **Fix:** Update the in-memory cache even when the file append fails: `this.cachedTotal += costUsd` before the try block, not after.

> **MEDIUM-8 — No periodic reconciliation for missed watcher events**
> **Location:** `src/watcher/index.ts` (absence)
> **What happens:** After the initial chokidar scan (`ignoreInitial: false`), all file detection relies on inotify events. If events are missed (inotify queue overflow, ENOSPC, polling mode on network mounts), changes are permanently invisible.
> **Fix:** Add a configurable periodic full-scan (e.g., every 30 minutes) that compares `raw/` contents against a "known-processed" set. Surface any discrepancies as new batches.

> **MEDIUM-9 — Unsafe `(err as Error).message` cast in 12+ locations**
> **Location:** `queue.ts:127,261`, `wiki-writer.ts:109`, `prompt-builder.ts:64`, `git-committer.ts:71`, `query-engine.ts:170`, `server/index.ts:313`, `cli/index.ts:72,74`, `start.ts:37`, `stop.ts:27`, `compounding/engine.ts:196`, `synthesize.ts:82`
> **What happens:** If `err` is not an Error instance (string, null, object), `.message` is `undefined`, producing `"process error: undefined"` or breaking regex tests.
> **Fix:** Use a utility: `function errMsg(e: unknown): string { return e instanceof Error ? e.message : String(e); }`. Apply globally.

> **MEDIUM-10 — Lint command defaults to "api" mode on execution mode failure**
> **Location:** `src/cli/commands/lint.ts:191-196`
> **What happens:** `let runtimeMode: RuntimeMode = "api";` is set before the try block. If `resolveExecutionMode` throws, the catch is empty and `runtimeMode` stays `"api"`. Downstream heal handlers will attempt API calls that fail.
> **Fix:** Set the default to a sentinel or explicitly handle the no-runtime case: `let runtimeMode: RuntimeMode | null = null;`. Skip LLM-dependent heals when null.

### LOW Findings

> **LOW-1 — `serve.ts` is a dead stub with stale message**
> **Location:** `src/cli/commands/serve.ts:37`
> **What happens:** Prints "MCP server scaffolding lands in Phase 3." The MCP server exists and works. This command confuses users.
> **Fix:** Either wire it to the actual server or remove the command.

> **LOW-2 — `sanitizeSlug` can produce collisions via `"untitled"` fallback**
> **Location:** `src/wiki/store.ts:185`
> **What happens:** Multiple different empty/punctuation-only inputs produce the same `"untitled"` slug, causing file path collisions.
> **Fix:** Append a short hash of the original input: `cleaned || \`untitled-${sha256Hex(original).slice(0,8)}\``.

> **LOW-3 — Error messages sent to LLM as source file content**
> **Location:** `src/ingestion/prompt-builder.ts:62-68`
> **What happens:** When a source file can't be read, the error message becomes an "excerpt" sent to the LLM: `[failed to read: ENOENT...]`. The LLM may try to interpret this string.
> **Fix:** Mark the excerpt with a structured signal the LLM can recognize, or skip unreadable files entirely.

> **LOW-4 — `fileExists`/`dirExists` return false on EACCES**
> **Location:** `src/utils/fs.ts:111-127`
> **What happens:** Permission-denied is indistinguishable from "doesn't exist." Could cause code to try to create a directory it can't access rather than reporting the permission error.
> **Fix:** Catch only ENOENT for `false`, re-throw EACCES.

> **LOW-5 — `atomicWrite` orphans temp files on rename failure**
> **Location:** `src/utils/fs.ts:57-72`
> **What happens:** If `renameSync` fails after `writeFileSync` succeeds, the `.tmp` file remains on disk.
> **Fix:** Add a `finally` block that `rmSync(tmp, { force: true })` if the rename didn't succeed.

> **LOW-6 — Model router hardcoded pricing table**
> **Location:** `src/ingestion/model-router.ts:20-27`
> **What happens:** Pricing for 6 models is hardcoded. Unknown models silently get Opus-tier pricing ($15/$75 per 1M tokens), which may reject affordable batches.
> **Fix:** Log at `warn` when the fallback pricing is used for an unknown model.

> **LOW-7 — heal-handlers.ts hardcodes `model_id: "claude"`**
> **Location:** `src/wiki/heal-handlers.ts:487`
> **What happens:** The provenance record says `"claude"` regardless of which model actually ran.
> **Fix:** Pass the actual model ID through from the model router.

> **LOW-8 — `get_index` returns placeholder as success**
> **Location:** `src/server/tools.ts:205`
> **What happens:** `(await ctx.indexManager.read()) ?? "_index not yet built_"` returned without `isError`. MCP clients render this placeholder as real content.
> **Fix:** Return with `isError: true` when the fallback is used.

---

## 3. Data Flow Traces

### Trace 1: Raw File → Wiki Page (Ingestion Pipeline)

1. **Source:** User drops `raw/notes.md` on disk
2. **Watcher detects** (`src/watcher/index.ts:139`): chokidar fires `add` event → `readFileSync(path, "utf8")` — **if read fails, event silently dropped (no retry)**
3. **Classification** (`event-classifier.ts`): sha256 hash compared to previous → intent `"new"` or `"update"` — **but intent is overwritten to `"update"` at batch emission (watcher/index.ts:173)**
4. **Debounce** (`debounce.ts`): path added to pending set → timer starts → timer fires → `flushNow()` → `onBatch(batch)` — **if onBatch throws, batch permanently lost**
5. **Queue enqueue** (`queue.ts:112`): outer try/catch → `process(batch)` — **if process throws, returns success-shaped `IngestionOutcome` with `skipped: true`**
6. **Source hashing** (`queue.ts:204-207`): `sha256File(path)` — **if file disappeared, hash is literal string `"missing"`**
7. **Prompt build** (`prompt-builder.ts:52-68`): file read → excerpt — **if read fails, error message becomes excerpt content sent to LLM**
8. **LLM invocation** (CLI: `cli-invoker.ts` / API: `llm-invoker.ts`): prompt sent → response received — **CLI: if stdin write fails, continues with no prompt; all metrics hardcoded to 0. API: if SDK result fields missing, default to 0/empty**
9. **Reconciliation** (`wiki-writer.ts:59-110`): parse agent-written files → validate paths → **if parse fails, file left as zombie on disk. If zero files written, batch continues as "success"**
10. **Wiki write** (`store.ts:104-107`): `atomicWrite(path, serialized)` — no try/catch in the loop, partial failure possible
11. **Cross-ref repair** (`cross-reference.ts`): bidirectional link repair — **broken references silently skipped**
12. **Index rebuild** (`index-manager.ts`): sentinel-block replacement — **no provenance for index.md itself**
13. **Search rebuild** (`search.ts:56-62`): `removeAll()` then `addAll(docs)` — **if addAll fails, index is empty (no rollback)**
14. **Git commit** (`git-committer.ts`): `commitAll` with retry — **if git fails, pages on disk but uncommitted**
15. **Provenance** (`queue.ts:330-347`): `chain.append(record)` — **fsync failure swallowed; if append throws, catch swallows and batch reports success**
16. **Sink:** Wiki page on disk, in search index, in provenance chain, committed to git

**At the sink, can the consumer distinguish real data from corrupted/missing data? No.** A batch where the LLM refused to respond, where stdin failed, where the search index failed to rebuild, or where provenance failed to append — all produce the same `IngestionOutcome` shape with `skipped: false, pagesWritten: 0` or `pagesWritten: N` with no error flags. **CRITICAL.**

### Trace 2: MCP Query → Answer

1. **Source:** MCP client sends `query` tool call with `question` string
2. **Auth** (`middleware.ts`): Bearer token check — **if no auth configured and loopback, silently permitted**
3. **Budget check** (`query-engine.ts:76-89`): `wouldExceedDaily()` — **depends on cost file being readable (CRITICAL-4)**
4. **Query expansion** (`query-expansion.ts`): LLM generates keyword variants — **if fails, bare `catch {}` with debug-level log, falls back to original query. Cost of failed call lost from result but tracked in cost file**
5. **Search** (`query-engine.ts:115`): `search.search(query, k)` — **if index is empty/broken, returns `[]`**
6. **Zero-hit guard** (`query-engine.ts:120-131`): `hits.length === 0` → returns `"No relevant wiki pages found..."` with `skipped: false` — **CRITICAL-1: indistinguishable from broken search**
7. **LLM invocation** (`query-engine.ts:141-157`): sends hits as context → receives answer — **if LLM fails, returns `skipped: true` with reason**
8. **Provenance** (`query-engine.ts:184-203`): `chain.append()` — **if fails, swallowed with log**
9. **Sink:** MCP tool response `{ content: [{ type: "text", text: answer }] }` — no `isError` flag for zero-hit case

**At the sink, can the consumer distinguish real data from corrupted/missing data? No.** A broken search index, a budget exhaustion, and "genuinely no matches" produce three different response shapes, but the first and third are indistinguishable to the client. **CRITICAL.**

### Trace 3: Heal Operation → Wiki Mutation

1. **Source:** `wotw lint --fix` or `LintScheduler.runOnce()` triggers heal
2. **Health report** (`health.ts`): scan all pages, compute scores — **pages with no provenance get worst staleness but perfect source availability (contradictory)**
3. **Finding selection**: findings below threshold selected for healing
4. **LLM invocation** (`heal-handlers.ts:447-461`): agent called to fix the page — **if fails, returns null → `{ fixed: false }`. If cost tracking fails inside the try, it looks like LLM failure**
5. **Page write** (`heal-handlers.ts` via `store.writePage`): — **happens BEFORE provenance (single-writer violation)**
6. **Cross-ref repair** (in healDuplicate/healConsolidation): additional pages written — **NOT tracked in provenance**
7. **Search rebuild**: only in healDuplicate/healMissingBacklinks/healConsolidation — **healStale, healBrokenLinks, healContradiction skip this step (HIGH-1)**
8. **Provenance** (`heal-handlers.ts:481-499`): `chain.append()` — **if fails, swallowed. Caller returns `{ fixed: true }`**
9. **Git commit** (`heal-handlers.ts:509-519`): — **if fails, swallowed. Caller returns `{ fixed: true }`**
10. **Sink:** Healed page on disk, possibly stale in search index, possibly missing from provenance, possibly uncommitted

**At the sink, can the consumer distinguish real data from corrupted/missing data? No.** A heal that succeeded on disk but failed at provenance and git returns `{ fixed: true }`. A heal where the search index wasn't rebuilt leaves the old content searchable. **HIGH.**

---

## 4. Failure Simulation Results

### Generic Scenarios

| # | Scenario | What does the user/caller see? |
|---|----------|-------------------------------|
| 1 | Primary data source returns HTTP 500 | API mode: `invokeIngestionAgent` throws → queue catches → `IngestionOutcome { skipped: true, skipReason: "agent error: ..." }` → logged at ERROR. DLQ entry written. User sees no wiki output but error is visible in logs. **Priority 3 — acceptable.** |
| 2 | Primary data source returns 200 with empty body | API mode SDK: `finalText = r.result ?? ""` → empty string. `writtenPaths` likely empty. Batch reports `skipped: false, pagesWritten: 0`. **Priority 4 — CRITICAL-8.** |
| 3 | Primary data source returns 200 with malformed/partial JSON | API mode: SDK stream parsing may throw → caught by retry → after retries exhausted, queue catches → `skipped: true`. But if the SDK accepts partial JSON and returns it as `finalText`, the malformed content may be written as a wiki page. **Priority 3-4 depending on SDK behavior.** |
| 4 | Primary data source times out after 30s | API mode: SDK throws timeout error → retry with exponential backoff (2s, 4s, 8s) × 2 retries → queue catches → `skipped: true` + DLQ. CLI mode: 10-minute default timeout → SIGTERM → `success: false`. **Priority 3 — acceptable.** |
| 5 | Auth token is expired/invalid | MCP server returns 401 with `"invalid or missing token"`. **Priority 3 — acceptable.** |
| 6 | Rate limit hit (429) | MCP middleware returns 429 with `"too many requests"`. Anthropic API 429: SDK retries internally. CLI mode: claude binary handles its own retries. **Priority 3 — acceptable.** |
| 7 | DNS resolution fails (ENOTFOUND) | API mode: SDK throws → retry loop → queue catches → `skipped: true` + DLQ. **Priority 3.** |
| 8 | Required environment variable is missing or empty string | `ANTHROPIC_API_KEY` missing: API mode `resolveExecutionMode` falls back to CLI if binary found, throws `ExecutionModeError` if neither available → daemon refuses to start. **Priority 3 — acceptable.** Empty string: `auto` mode may pick CLI over API depending on detection order. **Priority 2 — visible fallback.** |
| 9 | Database query returns 0 rows | N/A — no database. MiniSearch returns `[]` → zero-hit guard activates → **CRITICAL-1 applies.** |
| 10 | File read target doesn't exist or is 0 bytes | `readTextOrNull*` returns null → callers handle with early return or skip. Source file disappeared between watcher event and read → event silently dropped (**CRITICAL-7 partial**). 0-byte file: `readFileSync` returns `""` → `parsePage` may fail → zombie file or skipped excerpt. **Priority 3-4 depending on code path.** |
| 11 | Downstream write/emit succeeds but upstream fetch failed — stale/empty data written? | Yes. If the LLM invocation fails but a previous reconcile step already wrote cross-references or index updates, those partial writes persist. Git commit may commit the partial state. **Priority 4 — partial mutation without rollback.** |
| 12 | Code runs for the first time with no prior state/cache | Config uses all defaults (MEDIUM-3: no warning). Provenance chain file doesn't exist → touched empty → genesis hash. Cost file doesn't exist → $0. Search index empty. `ignoreInitial: false` scans `raw/` for existing files. **Priority 2 — works but no disclosure of defaults.** |

### wotw-Specific Scenarios

| # | Scenario | What does the user/caller see? |
|---|----------|-------------------------------|
| 13 | Claude CLI binary not found on PATH / not installed | `resolveExecutionMode` throws `ExecutionModeError("no_cli_binary")` → daemon logs fatal and exits. **Priority 3 — acceptable.** Unless mode is `auto` and `ANTHROPIC_API_KEY` is set → silently falls to API mode. **Priority 2 — visible in logs but not in config.** |
| 14 | Claude API returns 529 (overloaded) during ingestion | SDK throws → retry loop (2 retries) → if all fail, queue catches → `skipped: true` + DLQ. **Priority 3.** |
| 15 | Claude returns valid JSON but wrong schema (missing `title`, empty `content`) | `parsePage` silently coerces: missing title → derived from filename, missing category → `"concept"`, empty body → empty page written. **MEDIUM-5 applies.** The page exists but may have meaningless content. **Priority 4 — valid-looking page with garbage data.** |
| 16 | Provenance chain file is corrupted (invalid JSON, truncated) on daemon start | **CRITICAL-5 applies.** If all lines are malformed → chain silently resets to genesis. If some lines are malformed → `readAll()` skips them with `warn` log, `init()` sets state from last parseable record. Sequence numbers may have gaps. **Priority 4.** |
| 17 | MiniSearch index has 500 pages but a page write silently fails to re-index | `search.rebuild()` throws during `addAll()` → **HIGH-8**: index left empty after `removeAll()`. `search.upsert()` throws → `byId` map and engine may be out of sync. Page exists on disk but is unsearchable. **Priority 4 — invisible to queries.** |
| 18 | `raw/` file is 50MB PDF | `readFileSync` in prompt-builder reads entire file into memory. If the process doesn't OOM, the file is truncated at `MAX_EXCERPT_BYTES` (32KB) with `...[truncated]`. The LLM sees only the first 32KB. If OOM: uncaught → daemon crashes. **Priority 3 for truncation (visible), Priority 4 for OOM (silent crash).** |
| 19 | Two `wotw start` instances launched simultaneously | PID check (line 117) → both pass (PID not yet written) → lock acquisition (line 125) → one succeeds, one throws. The loser reports "Could not acquire start lock." The PID file race is mitigated by the lock. **Priority 3 — mostly acceptable.** But the 10s stale timeout means a slow startup could be hijacked. |
| 20 | `wotw lint --fix` heals a page but provenance append fails | Page written to disk. `recordHealProvenance()` catches error at line 497. `commitHealChanges()` succeeds. Returns `{ fixed: true }`. **HIGH-2 applies.** Audit trail has a gap. **Priority 4 — mutation without audit record.** |
| 21 | Obsidian vault path contains spaces or unicode characters | `vault-detect.ts` handles spaces via `shellQuote` (POSIX: `'path with spaces'`; Windows: `"path with spaces"`). Unicode paths: `readFileSync`/`statSync` handle them natively on modern Node.js. `resolveWikiPath` in tools.ts does `path.resolve` which handles unicode. **Priority 1 — works correctly.** |
| 22 | Network drops mid-stream during a Claude API response | SDK stream iteration throws → caught by `llm-invoker.ts:200-202` → retries. If all retries fail → queue catches → `skipped: true` + DLQ. However, if the agent wrote files via tool calls before the stream dropped, those files persist on disk but `writtenPaths` is from the partial stream. Some written files may be missed. **Priority 3-4 — partial writes may be orphaned.** |
| 23 | DLQ has 200 failed items — user runs `wotw start` fresh | DLQ file is read-only by `count()` and `list()`. No auto-replay mechanism. The 200 items sit in the file. `wotw status` shows `failed_batches: 200`. `get_stats` shows `failed_batches: 200`. **User is informed but must manually intervene.** **Priority 2 — visible but no auto-recovery.** |
| 24 | `wotw approve` called on a candidate whose source raw file was deleted | The candidate file exists in `candidates/`. `approveOne` reads it, parses it, writes it to `wiki/`. The `sources:` frontmatter still references the deleted raw file. Future health checks will flag low `source_availability`. **Priority 2 — approval succeeds, health check catches it.** But no warning at approval time. |

---

## 5. Risk Verdict

**🔴 FAIL** — 10 CRITICAL findings (Priority 4 violations). The codebase has multiple code paths where silent failures produce data indistinguishable from success. The most dangerous:

1. A broken search index silently returns "no results" to every query
2. Budget enforcement is non-functional in CLI mode
3. The provenance chain (the tamper-evident audit trail) can silently reset, lose records, or record non-durable writes
4. Failed ingestion batches are permanently dropped by the watcher
5. The daemon can crash on startup with zero diagnostic output

---

## 6. Summary

**Total findings by severity:** CRITICAL: 10 | HIGH: 8 | MEDIUM: 10 | LOW: 8

**Top 3 risks in plain language:**

1. **The search system can silently break and every query will return "no results found" as if that's a normal answer.** No MCP client can tell the difference between "your wiki has nothing relevant" and "the search engine is completely broken." This will cause users to lose trust in the system or, worse, make decisions based on "no relevant information" when relevant information actually exists.

2. **The budget guardrails are theater in CLI mode and fragile in API mode.** CLI mode records $0 for every batch. API mode's cost file can become unreadable (returning $0 spent). Either scenario allows unlimited LLM spending with no safeguard. The user who sets `max_daily_usd: 5.0` and walks away will get a surprise bill.

3. **The provenance chain — the core audit trail — has 6 distinct failure modes that silently compromise it.** Corrupted chain files reset silently. Fsync failures are swallowed. Five call sites swallow append failures. Heal operations and vocabulary enrichment record synthetic/static hashes instead of actual content fingerprints. Cross-reference repairs during healing create mutations invisible to provenance. An auditor using `wotw audit` will see a passing chain with silent gaps.

**Recommended test cases to add:**

1. **Search index degradation test:** Build wiki with 10 pages. Call `search.removeAll()` without rebuilding. Execute a query via MCP. Assert the response has `isError: true` or `skipped: true` — not a normal "no results" answer.

2. **Budget enforcement under file corruption:** Write a cost-log.jsonl with valid entries totaling $8. `chmod 000` the file. Call `wouldExceedDaily(1.0)` with `max_daily_usd: 5.0`. Assert it throws or returns `true` (would exceed) — not `false` ($0 spent).

3. **Watcher batch retry on transient failure:** Configure `onBatch` to throw on first call and succeed on second. Drop a file in `raw/`. Assert the file is processed on the retry — not permanently dropped.

4. **Provenance chain corruption detection:** Write 5 valid records to the chain file. Corrupt the middle record. Call `chain.init()`. Assert it throws or logs at ERROR — not silently reset to genesis.

5. **CLI mode stdin failure propagation:** Mock `child.stdin.write` to throw EPIPE. Call `invokeCliAgent`. Assert `result.success === false` — not `true` with zero pages.

6. **Zero-output batch detection:** Mock the LLM to return a polite refusal with no tool calls. Run ingestion. Assert `outcome.skipped === true` with `skipReason` containing "no wiki pages" — not `skipped: false, pagesWritten: 0`.

---

## Appendix: Bare `catch {}` Inventory (28 instances)

| File | Line(s) | What's swallowed |
|------|---------|-----------------|
| `chain.ts` | 176 | fsync failure |
| `chain.ts` | 329-331 | sizeBytes stat error |
| `store.ts` | 138, 155 | listCandidates/listRejected stat |
| `store.ts` | 198 | pageStat stat |
| `wiki-writer.ts` | 100-101 | staging cleanup |
| `prompt-builder.ts` | 129-130, 143-144 | rejected dir/file reads |
| `heal-handlers.ts` | 497-499 | provenance append |
| `heal-handlers.ts` | 517-519 | git commit |
| `vocabulary-enricher.ts` | 163-178 | page read/write (no logging) |
| `vocabulary-enricher.ts` | 216-217 | provenance append |
| `vocabulary-enricher.ts` | 234-235 | git commit |
| `query-engine.ts` | 109-111 | query expansion |
| `query-metrics.ts` | 63-64, 83-84 | file read, JSON parse |
| `tools.ts` | 260-262, 281-283 | health/metrics computation |
| `server/index.ts` | 154-156, 178-179, 290-297 | socket/transport close |
| `daemon/index.ts` | 218-220 | lock release |
| `process-manager.ts` | 96-98 | child kill |
| `lint-scheduler.ts` | 118 | zero-hit metrics |
| `token-store.ts` | 81 | JSON parse |
| `git.ts` | 39 | git config read |
| `fs.ts` | 113, 125 | fileExists/dirExists stat |
| `lifecycle.ts` | 45-47 | PID file read |
| `approve.ts` | 112, 132, 159 | cleanup, provenance, git |
| `reject.ts` | 76-78 | file cleanup |
| `status.ts` | 110, 128, 175, 183, 206, 213, 227, 242, 249, 267 | various stat/read/parse |
| `vault-detect.ts` | 80, 86, 98, 124 | registry/stat reads |

---

*End of audit. This report should be reviewed alongside the code and prioritized fixes should be tracked in a fix tracker document.*
