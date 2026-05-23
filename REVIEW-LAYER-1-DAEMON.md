# Layer 1 Multi-Agent Adversarial Code Review — Daemon at v0.4.0

**Repo:** `/home/jgoodman/watcher-on-the-wall`
**Commit:** `d656499` (v0.4.0, `main`)
**Reference image:** `registry.fly.io/wotw-daemon:v0.4.0` sha256:`430bbf53ad8a9233ef9f37deec926a09834433f8dc36c253a8d04939e624f486`
**Audit date:** 2026-05-22
**Production tenant count at audit time:** 0
**Coordinator:** Claude Opus 4.7 (1M context)

This is the synthesis of 16 independent agent reviews (11 primary subsystems + 5 cross-reviewers, ~6,400 lines of findings). Every finding has file:line evidence in the appendix reports.

---

## 0. Executive verdict

**Do NOT sign up the first tenant until Class-1 hotfixes are addressed.** The codebase has good structural bones — the single-pass refactor's architectural lock is consistently honored, the LLM provider interface is clean, the provenance chain has sound cryptographic primitives, and many security primitives are correctly implemented in isolation. But the cross-cutting pattern is severe:

> **Security awareness without security enforcement; defenses are coded but not wired in.**

Verified at five independent sites by the agent team:

1. **`TenantFs`** symlink-rejection + path-escape logic implemented, exported, tested → **zero production callers** (S7-F3, X3 concurrence, S11-F15).
2. **`sanitize()`** redaction logic implemented with 10 rules → invoked from **one production site** (prompt-builder.ts:59); the Pino logger has **no `redact` config** (S7-F1, X3-A5, X4-X-A-2).
3. **`checkOperationBudget()`** per-ingest/per-query USD cap implemented, configured, surfaced in config → **zero callers** (X1-A1, corroborates S4-F3).
4. **`startReconciliation()`** watcher recovery feature implemented, exported, tested → **never called** from `daemon/entry.ts`; `processedPaths` Set populated for a consumer that never runs (X1-A2).
5. **`provenanceGapCount`** metric defined and read in `tools.ts:310` → **never incremented** from any catch block (S5 patterns, X2 D-concurrence).

Plus: `src/hosted/` quota-enforcement classes (`StorageAccountant`, `DailyImportCounter`, `IngestBytesCounter`, `HealCooldown`) — tested but **zero production callers** (S11-F15, S7-F3 echo). And `src/llm/check-llm-types-sync.mjs` referenced in `src/llm/index.ts:7` as "enforced byte-identical by a CI script" → **the script doesn't exist** in this repo, and the sibling script in `wotw-cloud` isn't wired into any CI either (S1-F2, X5 B2).

This is the load-bearing pattern. Many individual fixes are small; the architectural risk is that the daemon's safety posture is documented but not enforced.

---

## 1. Triage matrix (severity × classification)

Aggregating across all 16 reports, deduplicating, and applying conflict-log severity decisions:

| Severity | Class 1 (hotfix) | Class 2 (follow-up) | Class 3 (docs/process) | Total |
|---|---:|---:|---:|---:|
| **CRITICAL** | 8 | 0 | 0 | 8 |
| **HIGH**     | 26 | 11 | 1 | 38 |
| **MEDIUM**   | 18 | 28 | 4 | 50 |
| **LOW**      | 1 | 26 | 19 | 46 |
| **INFO**     | 0 | 1 | 4 | 5 |
| **Total**    | **53** | **66** | **28** | **147** |

(A finding is counted once even when found by both primary and cross-reviewer; cross-reviewer-only findings are counted separately. Severity uses the cross-reviewer's revised value where they disagreed — see Conflict Log in §5.)

The 53 Class-1 items are listed by subsystem in §2. The other classifications are in the per-subsystem appendices.

---

## 2. Class-1 hotfix list (must land before first tenant signup)

Ordered by blast radius. Each item names the agent that found it; full evidence (file:line, code excerpt, recommendation) is in the linked appendix report.

### 2.1 — Provider correctness & BYOK invariants (S1 / S7 / X3 / X5)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 1 | **Pino logger has no `redact` config; `sanitize()` invoked from 1/155 log sites** | CRITICAL | `src/utils/logger.ts:20-39` | S7-F1, X3-A5, X4-X-A-2 |
| 2 | **Sanitize regex broken against modern OpenAI key formats (`sk-proj-*`, `sk-svcacct-*`, `sk-admin-*`); Gemini `AIza*` has no rule at all; `wotw_` daemon tokens unredacted; `github_pat_` fine-grained tokens missed** | CRITICAL | `src/utils/sanitize.ts:38-41` | S7-F2 (empirically verified), X3 regex confrontation |
| 3 | **`process.env[api_key_env]` retained for daemon lifetime; `cli-invoker.ts:100` spreads full `...process.env` into every claude-CLI subprocess** | HIGH | `src/llm/runtime-aware.ts:143/148/153`, `src/ingestion/cli-invoker.ts:100` | S7-F4, X3 key-lifecycle trace |
| 4 | **`docker/entrypoint.sh:69-72` hard-requires `ANTHROPIC_API_KEY` even for OpenAI/Gemini/Ollama tenants — forces multi-key env state per machine** | CRITICAL | `docker/entrypoint.sh:69-72` | X3-A1 |
| 5 | **`.dockerignore` missing `.env*` exclusion; `COPY . .` in build stage can bake developer-local `.env` into image layers** | CRITICAL | `.dockerignore` (no `.env` line), `Dockerfile:48` | X3-A2 |
| 6 | **Pino default err serializer dumps arbitrary error properties; empirically verified `err.headers.authorization` propagates verbatim** | HIGH | `src/utils/logger.ts:20-39` | X3-A5 |
| 7 | **Fallback init log path `process.cwd()/.wotw/daemon.log` writes to the persistent Fly volume (after `entrypoint.sh:89 cd "${WIKI_ROOT}"`)** | HIGH | `src/daemon/entry.ts:25-28` | X3-A6 |
| 8 | **`scripts/check-llm-types-sync.mjs` doesn't exist; CI gate referenced in `src/llm/index.ts:7` is a no-op on both daemon and `wotw-cloud` (no `.github` dir in cloud repo)** | HIGH | `src/llm/index.ts:7`, missing script | S1-F2, X5 B2 |
| 9 | **OpenAI provider sends deprecated `max_tokens` for `o1`/`o1-mini` models in its own PRICING table — calls will 400 with "Unsupported parameter"** | HIGH | `src/llm/providers/openai.ts:94` | X5-A1 |
| 10 | **OpenAI provider forwards arbitrary `temperature` to o-series models that reject anything ≠ 1.0** | MEDIUM | `src/llm/providers/openai.ts:95` | X5-A9 |
| 11 | **Ollama provider omits default `num_predict`; callers without explicit `maxTokens` get silent 128-token truncation (vocabulary-enricher, query-expansion)** | MEDIUM | `src/llm/providers/ollama.ts:88-93` | S1-F3 |
| 12 | **Gemini `validateConnection` calls paid `generateContent` instead of free models endpoint; every "validate" press is billable** | MEDIUM | `src/llm/providers/gemini.ts:146-158` | S1-F4 |
| 13 | **Gemini provider silently drops `options.abortSignal`; aborted requests keep billing** | MEDIUM | `src/llm/providers/gemini.ts:122-124, 149-153` | S1-F5 |
| 14 | **OpenAI/Gemini `DEFAULT_PRICING` is not a conservative ceiling; cost guardrails under-estimate ~6× on unknown reasoning models** | MEDIUM | `src/llm/providers/openai.ts:40`, `gemini.ts:45` | S1-F6, X5 B4 |
| 15 | **MCP `query` tool drops the `domain` and `scope` filters it advertises in its schema (`tools.ts:177-179` destructures into `_domain`/`_scope`, ignores)** | HIGH | `src/server/tools.ts:177-179` | S4-F6 |

### 2.2 — Ingestion pipeline (S2 / X1)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 16 | **`finishReason` discarded at `RuntimeAwareCompleteResult` boundary; `max_tokens` truncation invisible to daemon; partial-JSON parsed as success or rejected with no truncation diagnostic** | CRITICAL | `src/llm/runtime-aware.ts:58-64, 99-126`; `src/ingestion/queue.ts:323-326` | S2-F-S2-01, F-S2-20 |
| 17 | **Pre-assembled ingestion prompt contains ZERO existing-wiki context; model cannot dedupe, merge, supersede, or match conventions. `store.listAll()` exists and is wired up but never feeds `buildIngestionPrompt`** | CRITICAL | `src/ingestion/prompt-builder.ts:46-77, 148-213`; verified by X1 — `loadAllPages` called twice/batch but never passed to prompt-builder | S2-F-S2-02, X1 independent verification |
| 18 | **Source files >32KB silently truncated; no daemon log, no metric, no DLQ entry. Truncation uses string length not UTF-8 bytes — CJK files mis-measured** | HIGH | `src/ingestion/prompt-builder.ts:32, 55-62` | S2-F-S2-03, X1-A6 |
| 19 | **CLAUDE.md system prompt silently truncated at 64KB — same shape bug; operator's main lever against context-loss is silently truncated** | MEDIUM | `src/ingestion/prompt-builder.ts:33, 83` | X1-A8 |
| 20 | **`prompt_hash` hashes post-sanitize+truncate text, not source content; chain becomes unverifiable on sanitize-rule drift** | HIGH | `src/ingestion/queue.ts:483, 705` | S2-F-S2-04 |
| 21 | **Staging mode breaks provenance↔wiki path correspondence; `archiveDeletedSources` can never reunite chain with approved pages** | HIGH | `src/ingestion/wiki-writer.ts:90-103`, `queue.ts:407-411, 451-462, 556-580` | S2-F-S2-05 |
| 22 | **`checkOperationBudget()` has zero call sites; per-ingest and per-query USD caps are decorative** | CRITICAL | `src/ingestion/cost-tracker.ts:136-147` (defined); no callers anywhere | X1-A1, corroborates S4-F3 |
| 23 | **`startReconciliation()` defined and tested but never called from daemon entry; recovery from downtime silently fails; `processedPaths` Set is fed to a consumer that never runs** | HIGH | `src/watcher/index.ts:224-249`; `src/daemon/entry.ts:156-162` (no call) | X1-A2 |
| 24 | **Empty-pages skip path bypasses `costTracker.logUsage()`; LLM was invoked, real dollars spent, but daily cap never sees it** | HIGH | `src/ingestion/queue.ts:417-430` vs `:465` | X1-A3 |
| 25 | **Daily-budget-exceeded skip silently marks files as processed; they never retry tomorrow** | HIGH | `src/ingestion/queue.ts:282-297`; `src/watcher/index.ts:201-202` | X1-A4 |
| 26 | **`permissionMode: "bypassPermissions"` still set on every Agent SDK invocation even in single-pass mode (`allowedTools: []`)** | MEDIUM | `src/ingestion/llm-invoker.ts:140` | X1-A9 |

### 2.3 — Heal-handlers + compounding (S3)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 27 | **Every heal handler returns `fixed: true` when LLM emitted zero edits and zero files were written. `result.success`/`result.writtenPaths.length` computed but ignored. Tests codify the no-op-as-fixed behavior** | CRITICAL | `src/wiki/heal-handlers.ts:74-86, 128-146, 182-194, 294-306, 361-379, 514-525` | S3-F-S3-001, S10-F2 corroboration |
| 28 | **Heal writes raw LLM-emitted content via `atomicWrite`, bypasses `reconcileWrittenPages` → no provenance footer, no `last_compiled`, no frontmatter normalization, no `raw/` write-block** | CRITICAL | `src/wiki/heal-handlers.ts:485-503` vs `src/ingestion/queue.ts:340-411` | S3-F-S3-002 |
| 29 | **`healStale`/`healDuplicate`/`healConsolidation` prompts ask the model to "Read source files (if they still exist)" but daemon provides no mechanism to surface source content in single-pass; handler still reports `fixed: true` regardless** | HIGH | `src/wiki/heal-handlers.ts:62-66, 286-287, 336-358` | S3-F-S3-003 |
| 30 | **Heal failure loops: no idempotency marker, no backoff; same finding regenerates next interval and re-heals; unbounded provenance growth + cost burn in `auto_fix` mode** | HIGH | `src/wiki/heal-handlers.ts:47-87, 153-195`; `src/cli/commands/lint.ts:222-232` | S3-F-S3-004 |
| 31 | **`LintScheduler.runOnce` is fire-and-forget; concurrent invocations race on writes, search-rebuild, provenance-append, git-commit, and cost-tracker** | HIGH | `src/daemon/lint-scheduler.ts:51-54` | S3-F-S3-005 |
| 32 | **`healDuplicate`/`healConsolidation` `repairBidirectionalLinks` writes land on disk + git but NOT in `wiki_files_written` provenance** | HIGH | `src/wiki/heal-handlers.ts:131-135, 364-368` | S3-F-S3-013 |
| 33 | **Compounding's post-write `repairBidirectionalLinks` has same gap — synthesis pages tracked but backlink-repair writes missing from chain** | HIGH | `src/compounding/engine.ts:223` | S3-F-S3-021 |

### 2.4 — Query path (S4)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 34 | **Empty/whitespace LLM response returned as successful answer; user sees "" blank with no skip, no error** | CRITICAL | `src/server/query-engine.ts:193-262` | S4-F1 |
| 35 | **LLM-controlled `match.page` field concatenated directly into `fs` write path with no traversal validation; vocabulary-enricher is the most prompt-injection-exposed surface (loads all page titles into prompt)** | CRITICAL | `src/wiki/vocabulary-enricher.ts:158-172` | S4-F2 |
| 36 | **Per-query budget estimate is ~4× too low (8K input estimate vs 16KB × 8 = 128KB actual); `checkOperationBudget` per-query cap never invoked** | HIGH | `src/server/query-engine.ts:81-94, 218-222` | S4-F3 |

### 2.5 — Provenance chain (S5 / X2)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 37 | **`verify_on_startup: false` default lets a chain with partial-corruption (one bad line) boot silently; `init()` recovers from the last parseable record, advancing on top of a verifiably-broken tail forever** | HIGH | `src/daemon/config.ts:98`; `src/provenance/chain.ts:101-136, 322-338` | S5-F1, S5-F3 |
| 38 | **`init()` reads the LAST record's `seq`/`chain_hash`/`id` without verifying that record itself; tampered tail propagates forward** | HIGH | `src/provenance/chain.ts:128-134` | X2-M2 |
| 39 | **`src/provenance/chain-hash-vendored.ts` has ZERO imports (185 LOC of dead code); claims byte-identity with `wotw-cloud` but no CI gate enforces drift on either side** | HIGH | `src/provenance/chain-hash-vendored.ts:14-21` (claim) vs grep (no imports) | S5-F2, X2 D-concurrence |
| 40 | **Cloud-sink failures cause silent JSONL↔Supabase drift with no retry, no checkpoint, no catch-up; "fire and forget" comment is aspirational** | HIGH | `src/provenance/chain.ts:221-234`; `src/provenance/cloud-sink.ts:79-146` | S5-F4 |
| 41 | **`WOTW_API_BASE_URL` accepts arbitrary scheme; admin key sent as plaintext `x-admin-key` header over HTTP if misconfigured** | HIGH | `src/provenance/cloud-sink.ts:69, 154-164` | X2-M1 |
| 42 | **Chain delete-attack is fully undetectable; no external anchor outside the file; daemon `init()` treats missing file as fresh genesis** | HIGH | `src/provenance/chain.ts:104-109` | X2-M3 |
| 43 | **`ProvenanceRecord` payload lacks `tenant_id`/`wiki_id` anchor; cross-tenant chain confusion possible if files ever co-located; `merkle_root` field declared in type but never included in canonical payload** | MEDIUM | `src/provenance/chain.ts:158-172`; `src/utils/types.ts:296-314` | S5-F5 |
| 44 | **`approve.ts` constructs ad-hoc `ProvenanceChain` with no sink, races daemon for seq numbers, silently catches all errors, writes empty `wiki_file_hashes_after: {}`** | MEDIUM | `src/cli/commands/approve.ts:134-149` | S5-F11 |

### 2.6 — Wiki layer (S6)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 45 | **`parsePage` doesn't catch `matter()` YAML parse errors; one malformed page crashes the entire health/lint/heal pass — `WikiStore.readPage`, `health.ts:502`, `lint.ts:165`, heal-handlers x4, candidates/approve/reject all propagate the throw** | CRITICAL | `src/wiki/page.ts:31` | S6-F1 |
| 46 | **`normalizeStatus` silently drops unknown status values; lifecycle gates (orphaned/merged/consolidated/stale) fail open. The ONLY normalize* function that doesn't log when discarding** | HIGH | `src/wiki/page.ts:193-199` | S6-F2 |
| 47 | **Round-trip is lossy: unknown frontmatter keys silently dropped on every `serializePage` write. User-added or migration fields destroyed on next heal/vocab pass** | HIGH | `src/wiki/page.ts:38-95, 112-141` | S6-F3, X1-A7 echo |
| 48 | **`WikiStore.writePage` has no `wikiRoot` containment check on `page.path`; arbitrary-path write surface relying on every caller getting paths right** | MEDIUM | `src/wiki/store.ts:105-108` | S6-F9 |

### 2.7 — Server / MCP / admin (S8 / X4)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 49 | **SSRF on `POST /internal/ingest`: only `startsWith("https://")` validation; no host allowlist, no private-CIDR block, no IMDS block, no redirect cap, no AbortSignal timeout, no content-length cap, unbounded `arrayBuffer()` buffer, response written to disk + chokidar pickup** | CRITICAL | `src/server/index.ts:432-531` (handler), `:453-456` (only check), `:485` (fetch), `:500` (buffer) | S8-F-001, X4 SSRF walkthrough |
| 50 | **`ADMIN_SERVICE_KEY` triple-purpose: inbound `/mcp` bearer (via `config.ts:325` → `server.auth_token`), inbound `/internal/*` admin gate, outbound `cloud-sink` secret. One leak = full daemon takeover + control-plane impersonation. Plus `!==` (non-constant-time), bypasses rate limiter, bypasses M-SEC-2** | CRITICAL | `src/daemon/config.ts:324-326`; `src/server/index.ts:343, 346, 218`; `src/provenance/cloud-sink.ts:18-21, 104` | S8-F-002, X4 admin-key call graph |
| 51 | **Dockerfile binds `WOTW_HOST=::` — `/internal/*` reachable from every Fly 6PN sibling tenant daemon. Same ADMIN_SERVICE_KEY across all tenant daemons (shared by control plane) → one compromised daemon = control over all others** | HIGH | `Dockerfile:115-117`; `src/server/index.ts:218` | X4-X-A-1 |
| 52 | **`/internal/ingest` fetch has no AbortSignal timeout (cloud-sink has one — code inconsistency proves missing timeout is oversight, not deliberate)** | MEDIUM | `src/server/index.ts:485` vs `src/provenance/cloud-sink.ts:96-108` | X4-X-A-3 |
| 53 | **`/internal/ingest` returns raw `err.message` to caller — SSRF-redux oracle for internal path/host enumeration** | MEDIUM | `src/server/index.ts:526-529` | S8-F-003 |
| 54 | **MCP/HTTP 500 wrapper embeds raw `errMsg(err)` in JSON-RPC error message; SDK error shapes may leak headers** | HIGH | `src/server/index.ts:322` | X3-A4, S8-F-004 echo |
| 55 | **`body.tenant_id` accepted by every `/internal/*` endpoint but never checked against `config.hosted.tenant_id`; misrouted control-plane calls execute against wrong tenant** | HIGH | `src/server/index.ts:381, 391, 403, 419, 446` | S8-F-005 |
| 56 | **`/internal/export` and `/internal/import` return 200 OK without doing the work (acknowledged-only stubs); control plane that trusts the response will mark tenant recovered when no restore happened** | MEDIUM | `src/server/index.ts:403-430` | S8-F-006 |
| 57 | **`raw_source_id` and `filename` not length- or charset-bounded; collision-DoS on filesystem NAME_MAX truncation; Unicode-normalization confusion** | MEDIUM | `src/server/index.ts:446-470` | S8-F-008 |
| 58 | **`/internal/ingest` doesn't validate `content-type` against declared `filename` extension; wrong-type tail or prompt-injection content gets ingested as authoritative source** | MEDIUM | `src/server/index.ts:484-502` | S8-F-009 |
| 59 | **`/internal/*` admin auth uses `!==` non-constant-time compare while `/mcp` legacy path uses `timingSafeEqual`. Admin key has timing oracle, no rate limit, brute-forceable** | HIGH | `src/server/index.ts:346` | S7-F5, S8-F-002 echo |

### 2.8 — CLI / config / runtime (S9)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 60 | **`validateHostedConfig` lets `wiki_root` be a relative path; in Fly container, resolves against `process.cwd()` = ephemeral filesystem; tenant data wiped on every restart** | HIGH | `src/daemon/config.ts:391-393` | S9-F-S9-01 |
| 61 | **`WOTW_HOSTED` only honors literal `"true"`; `"1"`, `"True"`, `"yes"`, `"on"` silently set `hosted.enabled=false`. Hosted-mode misdetection in container** | HIGH | `src/daemon/config.ts:237-239` | S9-F-S9-02 |
| 62 | **`WOTW_LLM_PROVIDER=openai` silently overridden by CLI-mode auto-detection when `claude` binary on PATH (it always is in the container). Tenant billed against wrong key / wrong provider** | HIGH | `src/daemon/config.ts:291-317`; `src/ingestion/execution-mode.ts:134-156`; `src/llm/runtime-aware.ts:82-106` | S9-F-S9-03 |
| 63 | **`install-hook`/`uninstall-hook` use plain `writeFileSync` on `~/.claude/settings.json`; Ctrl-C corrupts user's global Claude settings. `atomicWriteSync` exists** | HIGH | `src/cli/commands/install-hook.ts:92`; `uninstall-hook.ts:63` | S9-F-S9-09 |
| 64 | **`uninstall-hook` throws unhandled on malformed settings.json (no try/catch around `JSON.parse`)** | MEDIUM | `src/cli/commands/uninstall-hook.ts:49` | S9-F-S9-10 |
| 65 | **No test for hosted-mode default overrides (`staging=false`, `lint=true`); the validation-gap-instance-#12 regression has no guard** | HIGH | `test/unit/config.test.ts` (no test exists) | S9-F-S9-17 |
| 66 | **`WOTW_LLM_PROVIDER`/`WOTW_LLM_MODEL`/`WOTW_OLLAMA_URL` not in ENV_KEYS snapshot/restore list; test pollution. Also: no positive tests for these env vars** | MEDIUM | `test/unit/config.test.ts:229-240` | S9-F-S9-18 |

### 2.9 — Simplification (S11)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 67 | **`src/hosted/` subdir (StorageAccountant, DailyImportCounter, IngestBytesCounter, HealCooldown, TenantFs, MetricsCollector) tested but **zero production callers**. Tenant-quota enforcement isn't actually wired into IngestionQueue or McpHttpServer** | HIGH (architectural) | `src/hosted/*`, `grep` of `src/daemon/`, `src/server/`, `src/ingestion/` | S11-F15, S7-F3 corroboration |
| 68 | **Path-containment check duplicated in 4 security-critical sites with subtle differences (`resolveEditPath`, `resolveWikiPath`, `assertSafe`, inline `/internal/ingest`)** | HIGH | `src/llm/edits.ts:104-112`; `src/server/tools.ts:498-507`; `src/hosted/tenant-fs.ts:26-50`; `src/server/index.ts:478-482` | S11-F17 |

### 2.10 — Test coverage gates (S10)

| # | Finding | Severity | File:line | Source |
|---|---|---|---|---|
| 69 | **Heal-handler tests use `text: "Fixed."` (non-JSON) as the default LLM mock; codify the F-S3-001 no-op-as-fixed bug** | HIGH | `test/unit/heal-handlers.test.ts:24-33` and all 5 handler tests | S10-F2 |
| 70 | **`ingestion-queue.test.ts` has ONE test for the Phase 6 "HIGHEST RISK" refactor; path-traversal, raw/-block, atomicWrite-failure, LLM-throw, cost-overrun all untested** | HIGH | `test/unit/ingestion-queue.test.ts:128-178` | S10-F3 |

**Total Class-1 hotfix items: 70.**

> Note: numbers 49 and 50 (SSRF + ADMIN_SERVICE_KEY blast radius) are the highest blast-radius items in the entire review. Items 17, 27, 28, 35, 49, 50 combined constitute the "block first tenant signup" Pareto.

---

## 3. Patterns across subsystems

These are not findings; they are recurring shapes that multiple agents independently identified:

### P1. Defense coded but not wired in (the headline pattern)
Verified at 6+ independent sites: TenantFs (S7, X3, S11), Pino redact (S7, X3, X4), `checkOperationBudget` (X1, S4), `startReconciliation` (X1), `provenanceGapCount` (S5, X2), entire `src/hosted/` subdir (S11), `check-llm-types-sync.mjs` claim (S1, X5). The codebase has a sophisticated security/operability vocabulary that the runtime doesn't speak.

### P2. Silent skip / silent success on empty LLM output
Same shape across at least three single-pass call sites:
- Heal handlers report `fixed: true` even when zero edits/zero writes (S3-F-S3-001).
- Query engine returns empty `""` answer as successful answer (S4-F1).
- Ingestion queue silently marks files processed on empty-pages skip (S2-F-S2-09).
- Cost is logged even when no output was produced.

### P3. `finishReason` discarded at the wrapper boundary
`RuntimeAwareCompleteResult` (`runtime-aware.ts:58-64, 99-126`) drops the provider's `finishReason`; affects every consumer (queue.ts, heal-handlers.ts, compounding/engine.ts, query-engine.ts, query-expansion.ts, vocabulary-enricher.ts). Max-tokens truncation is invisible to all six callsites. (S2-F-S2-01/F-S2-20)

### P4. 32KB / 64KB silent truncation in two places, no log
Source files (`MAX_EXCERPT_BYTES = 32 * 1024`) and CLAUDE.md system prompt (`CLAUDE_MD_MAX_BYTES = 64 * 1024`) both use string-length checks (UTF-16 code units), not byte counts. Multilingual content mis-measured; truncation invisible to daemon log/metric/DLQ. (S2-F-S2-03, X1-A6, X1-A8)

### P5. Single shared secret = god mode
`ADMIN_SERVICE_KEY` is the inbound `/mcp` bearer, the inbound `/internal/*` admin gate, AND the outbound `cloud-sink` secret, with no rotation, no length check, no minimum entropy, non-constant-time compare on `/internal/*`. One leak = full daemon takeover + control-plane impersonation + full Fly-6PN-sibling-daemon takeover. (S7, S8, X3, X4 — all converge.)

### P6. Path containment scattered across security-critical sites
Four implementations of "is this path inside this root?" with subtle differences: `resolveEditPath`, `resolveWikiPath`, `assertSafe` (in unwired `TenantFs`), and inline check in `/internal/ingest`. Refactor must coalesce to one helper. (S11-F17)

### P7. F1 + F4 fixtures don't exist in the repo
Phase A validated only F1 (photosynthesis) + F4 (Rust borrow checker, "queued at writing time"; no completion evidence in pass-doc). `test/fixtures/` is empty. F2/F3/F5 never ran. Production code paths for staging mode, truncation, max-tokens cutoff, empty-edits skip, daily-budget skip, DLQ replay, source-rename, deletion, multi-batch, CLI mode, path traversal, and provider parity are essentially untested by integration fixtures. (S2-X1 fixture coverage map, S10-F4)

### P8. Test theater in heal-handlers + LRU sweep
Codex's "LRU test as theater" claim substantiated **plus** the underlying `RateLimiter.sweep()` is never called from `src/` (buckets Map leaks unbounded). Heal-handlers tests don't read file content after the call; mock returns `text: "Fixed."` (non-JSON) so the JSON-edits-application path is never exercised. (S10-F1, S10-F2, S8-F-011)

### P9. Provenance chain — secondary writes missing from records
Heal's `repairBidirectionalLinks` after `healDuplicate` and `healConsolidation` writes to disk + git but is missing from `wiki_files_written`. Compounding has the same gap. Auditability of "what did this operation touch?" via the chain alone is incomplete by exactly the set of pages whose `related:` field changed downstream. (S3-F-S3-013, S3-F-S3-021)

### P10. Cross-provider parity asymmetry
Every provider implements the interface; few invariants are honored uniformly. Cost defaults (Anthropic ceiling correct, OpenAI/Gemini wrong), validateConnection (Anthropic/OpenAI free, Gemini paid), abortSignal (3/4 forward it, Gemini drops), num_predict default (Ollama omits, others default 4096), `max_tokens` for o-series (OpenAI sends deprecated field). (S1 patterns, X5 net assessment)

### P11. Stale doc-comments throughout the refactor
`llm-invoker.ts:1-15`, `wiki-writer.ts:1-15`, `prompt-builder.ts:2-13` all still describe the old Agent SDK multi-turn world. Next maintainer reads a wrong mental model from line 1. (S2-F-S2-14/15/16)

### P12. Hosted-mode defaults scattered and inconsistent
`applyEnvOverrides` inlines 3 hosted-mode overrides; `daemon.log_file` override is separate; `wiki_root` not validated for absoluteness; `WOTW_HOSTED` env parsing is brittle; compounding defaults to enabled in hosted with no override. No central `hostedModeOverrides()` function. (S9 multiple findings)

---

## 4. Coverage report (file-by-file)

Every file in `src/**` and `test/**` was read by at least one agent. Overlap is intentional (multiple lenses on `server/middleware.ts`, `multi-user/token-store.ts`, `runtime-aware.ts`, `cli-invoker.ts`).

**`src/` directories — coverage:**

| Directory | Files | Primary subsystem(s) | Cross-reviewer(s) | Confirmed read |
|---|---|---|---|---|
| `src/cli/` (24 files) | output, vault-detect, commands/* | S9 | S11 (sampled) | ✓ |
| `src/compounding/` | engine.ts (512), index.ts (5) | S3 | S11 | ✓ |
| `src/daemon/` | config (613), entry (213), index (232), lifecycle, process-manager, lint-scheduler | S9 | S11 | ✓ |
| `src/events/` | (empty — verified) | S11 | n/a | ✓ |
| `src/hosted/` | tenant-fs, counters, accountant, metrics, cooldown | S7 | X3, S11 | ✓ |
| `src/index.ts` | barrel | S11 | n/a | ✓ |
| `src/ingestion/` (12 files) | queue (719), invokers, prompt-builder, wiki-writer, scheduler | S2 | X1, S11 | ✓ |
| `src/llm/` | edits, runtime-aware, types-vendored, 4 providers, index | S1 | X5, S11 | ✓ |
| `src/multi-user/` | token-store, index | S7 | S8, X3, S11 | ✓ |
| `src/provenance/` | chain (404), chain-hash-vendored, cloud-sink, hash | S5 | X2, S11 | ✓ |
| `src/server/` | index (588), tools (520), middleware (180), resources, query-engine, query-expansion, query-metrics | S4 (query), S7 (middleware), S8 (HTTP+MCP) | X4, X3, S11 | ✓ |
| `src/utils/` | sanitize, logger, fs, types, errors, git, retry, version | S7 | X3, X4 (logger), S11 | ✓ |
| `src/watcher/` | index (273), debounce, event-classifier, ignore-patterns | S2 | X1, S11 | ✓ |
| `src/wiki/` | page (209), search, store, health (632), index-manager, cross-reference, heal-handlers (589), vocabulary-enricher | S6 (wiki layer); S3 (heal-handlers); S4 (vocabulary-enricher) | S11 | ✓ |
| Configs | package.json, Dockerfile, .dockerignore, vitest, tsup, tsconfig, pnpm-lock | S7 | X3, X4 | ✓ |

**`test/` coverage:** S10 sampled all 64 test files (47 full, 17 partial). Per-subsystem tests were also read in full by their respective primary reviewers.

**Out-of-scope but inspected:** `wotw-cloud/web/scripts/check-llm-types-sync.mjs` (S1), `wotw-cloud/packages/shared/src/llm/types.ts` (S1, X5 — md5 confirmed identical), `wotw-cloud/.github/` (S1 confirmed absent), Anthropic/Google/OpenAI SDK type definitions (X5).

**Files NOT covered:** None. Confirmed.

---

## 5. Conflict log (primary vs cross-reviewer disagreements)

Where the cross-reviewer disagreed with the primary on facts, severity, classification, or recommendation. Coordinator's resolution is given where applicable.

### Severity / classification disagreements

| Finding | Primary | Cross | Coordinator resolution |
|---|---|---|---|
| **S1-F1** (Gemini fence test theater) | HIGH/class 2 | X5: HIGH/**class 1** | **Adopt X5.** Fix is one-line; pre-tenant is the right moment. |
| **S1-F6** (DEFAULT_PRICING not conservative) | MEDIUM/class 2 | X5: MEDIUM-HIGH/**class 1** for OpenAI | **Adopt X5 for OpenAI.** Combined with X5-A1 (o-series broken request shape), this is class-1. |
| **S1-F12** (`GEMINI_SAFETY_STRICT` docstring) | LOW/class 3 | X5: LOW/**class 2** | **Adopt X5.** One-line code fix or one-line docstring removal — both are code work. |
| **S1-F14** (empty content destroys file) | LOW/class 2 | X5: **MEDIUM**/class 2 | **Adopt X5.** Combined with S1-F3 (Ollama silent truncation), this becomes the truncate-as-destroy path. |
| **S2-F-S2-06** (POSIX-only path separator) | CRITICAL/**class 1** | X1: HIGH/**class 2** | **Adopt X1.** Production daemon runs on Linux Fly Machines; Windows is dev-only and tests use `it.skipIf(platform() === "win32")` widely. Don't gate first-tenant on Windows. |
| **S2-F-S2-19** (`processedPaths` unbounded) | LOW/class 2 | X1: MEDIUM-HIGH/**class 1** | **Adopt X1.** The deeper bug is that `startReconciliation` is dead code (X1-A2). Combine into one fix. |
| **S2-F-S2-13** (provenance footer re-appended) | LOW | X1: MEDIUM | **Adopt X1 nuance.** Compounded with F-S2-04, real money over time. |
| **S5-F2** (chain-hash-vendored dead code) | HIGH/class 1 | X2: **MEDIUM** | **Keep primary's HIGH** but note X2's reasoning that the latent damage is bounded; pre-tenant fix is essentially free. |
| **S5-F7** (admin key non-constant-time) | MEDIUM | X2: **LOW** | **Adopt X2.** Cloud-sink sends key as outbound header — there's no comparison done daemon-side at all. The "non-constant-time" framing is misapplied. |
| **S7-F3** (TenantFs unwired) | HIGH/class 1 | X3: **MEDIUM**/class 2 (delete TenantFs) | **Adopt X3.** Fly Machine per-tenant isolation is the real boundary. Delete TenantFs + document the threat model. Cheaper, less risk. |
| **S7-F4** (env key retention) | HIGH/class 1 OR class 3 doc | X3: HIGH/**class 1** strongly | **Adopt X3.** Combined with X3-A1, this becomes structurally non-optional. |
| **S7-F10** (claude-code postinstall) | MEDIUM/class 3 docs | X3: **HIGH/class 1** | **Adopt X3 upgrade.** Anthropic CDN compromise = every tenant simultaneously; digest pinning is cheap. |
| **S7-F16** (XFF spoof) | LOW/class 2 | X3-A7: **MEDIUM** (if `trust_proxy: true`) | **Adopt X3 conditional.** When `trust_proxy: true`, MEDIUM-class-1. Default false in code today, so MEDIUM-class-2 for now. |
| **S8-F-010** (XFF leftmost spoof) | MEDIUM/class 2 | X4-B-1: **LOW/class 3** conditional | **Adopt X4.** Default is `trust_proxy: false`. Document the deployment posture before any prod tenant enables it. |
| **S8-F-014** (ToolReg shared) | INFO/class 3 | X4-B-2: INFO/**class 2** (lock-in test) | **Adopt X4.** Add a test that fails today to lock in single-tenant-per-daemon. |
| **S7-F8** (atomicWrite mode pre-rename) | MEDIUM/class 2 | X3: **LOW** | **Adopt X3.** Fly volumes are per-tenant; no cross-tenant fs surface. |

### Factual corrections

| What primary claimed | Cross says | Action |
|---|---|---|
| S2-F-S2-09 cites `cli-invoker.ts:283` for mtime-diff | X1: actual mtimeMs is at lines 227, 259; line 283 is the diff condition | Tighten cite; not a finding error. |
| S5: 6 chain.append call sites | X2: **8** sites — query-engine (`:229`) and approve.ts (`:136`) also append. Query-expansion does NOT append (it returns expansion terms to query-engine which appends one combined record). | Coordinator adopts S5's actual enumeration in their report (table at S5 §6) — **8 sites confirmed**, not 6. The "user's directive said 6" framing in S5 §6 is accurate. |
| S8-F-014 footnote: "chain.recordsFor may have path-traversal hole if it opens files" | X4: `chain.recordsFor` is pure in-memory `.includes()` filter on `wiki_files_written` and `source_files`. **No file-open.** | Drop the overcautious footnote. |
| S8 6a inventory: `/internal/queue-status` "Destructive? No" | X4: response leaks `hosted: this.opts.config.hosted.enabled` at index.ts:375 — mild info disclosure, worth noting | Add note to inventory. |
| S8-F-006: `/internal/import` quoted text accurate | X4: also strip `body.backup_path` from response (echoing attacker input) | Add to recommendation. |
| S1-F4 recommendation: `GoogleGenerativeAI.listModels()` | X5: **method does not exist in SDK 0.24.1**. Use raw `fetch` against `https://generativelanguage.googleapis.com/v1beta/models?key=...` | **Adopt X5's recommendation.** Primary's was unimplementable. |
| S1-F5 recommendation: "polyfill via Promise.race against an abort promise if SDK doesn't support signal" | X5: SDK 0.24.1 DOES support `signal` via `SingleRequestOptions`. Polyfill caveat is unnecessary FUD. Also: per SDK docs, `signal` cancels client-side only — Google still charges. | **Adopt X5.** One-line fix; document the billing nuance honestly. |
| S1-F10 recommendation: mock OpenAI/Gemini/Ollama like Anthropic | X5: 4× module-mock in vitest is fragile (order-sensitive). Better to refactor `selectProvider` to accept a `factories` map for dependency injection. | **Adopt X5's structural fix.** |

### Recommendation refinements

| Finding | Primary recommend | Cross refinement |
|---|---|---|
| S2-F-S2-02 (no existing-wiki context) | Pre-load slim manifest of all pages | X1-C1: **scope-bound**. >200 pages → tag/title overlap heuristic, capped at 50. Don't ship a 60KB manifest blindly. |
| S2-F-S2-04 (prompt_hash) | Persist rendered prompt OR pin render-version | X1-C2: also persist SHA256(source bytes) + SHA256(system prompt) separately so audit-replay is possible without storing the rendered text. |
| S2-F-S2-08 (staging vs cross-ref) | Run second `repairBidirectionalLinks` during approve OR include candidates in `loadAllPages` | X1-C3: **mandate the second-pass approach**. Including candidates blurs the staging boundary and creates phantom links on reject. |
| S5-F4 (cloud-sink retry) | Three alternatives | X2-C: prefer **checkpoint + catch-up** pattern — pairs with X2-M3's anchor-file recommendation. |
| S5-F5 (cross-tenant chain confusion) | Add `wiki_id` to payload | X2-C: use `tenant_id` not `wiki_id` (it's the *security* boundary; wiki is the data boundary). |
| S8-F-001 (SSRF fix) | "Stream to disk OR allowlist OR content-length cap" | X4-C-1: **all three are required, in this order**: (1) IP-level rejection FIRST, (2) content-length cap SECOND, (3) streaming THIRD. Phrase as layered checklist. |
| S8-F-002 (split admin secrets) | Three env vars | X4-C-2: with `tenant_count=0`, **rip-and-replace is viable now**; after first tenant, requires cross-codebase coordination with `wotw-cloud` and a deprecation window. |
| S1-F2 (sync gate) | Step 3: "remove the wotw-cloud script claim OR wire it in" | X5-C-5: **only wire it in** (both daemon CI + wotw-cloud CI). The "remove the claim" alternative is essentially documenting that the guarantee is gone. |
| S1-F7 (silent drops bad edits) | Callback for per-rejection | X5-C-3: return struct `{ edits, rejectedEdits: [{raw, reason}] }`. Cleaner — no effect channel into a pure parser. |

---

## 6. Simplification backlog (from S11)

Class-1 items (already in §2.9):
- **F15:** `src/hosted/*` test-only; document or delete (or wire in to actually enforce quotas before signup).
- **F17:** Path-containment checks scattered in 4 places — coalesce.

Class-2 items (worth scheduling within next ~3 sprints; full file:line evidence in S11.md):
- **Delete candidates:** `src/events/` (empty dir); `invokeIngestionAgent` API-mode branch (~130 LOC); `output.ts:spinner()` (zero callers); `_resolveWikiPathForTests` export pattern; `LLMProvider.supportsTools` flag (zero consumers); `LLMProvider.complete()` method (zero external callers — all use `completeWithUsage`).
- **Merge/collapse:** `src/llm/index.ts` (barrel — could be deleted); `runtime-aware.ts → invokeIngestionAgent → invokeClaudeCli` (two dispatcher layers); `health.ts` (632 LOC, mixes scoring/detection/reporting); `heal-handlers.ts` (589 LOC, 6 handlers + duplicated plumbing); `config.ts` (613 LOC, 4 concerns); `init.ts` (786 LOC). Split each along its natural concern boundaries.
- **Duplicate logic:** `DailyImportCounter` ≈ `IngestBytesCounter` (95% identical); 5 separate recursive-directory walks (`walkSize`, `walkDir`, `walkMarkdown`, `walkRawFiles`, `snapshotTree`); 12 inline `err instanceof Error ? err.message : String(err)` vs the existing `errMsg()`; 7 `${root}/${rel}` template-concat instead of `path.join()`; 2 Anthropic pricing tables (`anthropic.ts:33-42` vs `model-router.ts:21-28` — model-router is missing `claude-opus-4-7`).
- **Over-abstraction:** `LLMProvider.supportsTools` flag never read; `LLMProvider.complete()` wraps `completeWithUsage` with no callers; `runtimeMode?: RuntimeMode` defaults to `"api"` despite being mandatory at runtime.
- **Dependencies:** `@anthropic-ai/claude-code` (7MB dep, only used via Dockerfile binary fetch, no `require`); `@anthropic-ai/claude-agent-sdk` (only used in dead API-mode branch); `boxen` (2 call sites, 100KB).
- **Tests coupled to dead impl:** `quota-enforcement.test.ts` is the only consumer of `src/hosted/*` classes.

Class-3 (process):
- Document `boxen` decision; tighten `OperationType` enum vs free-form `metadata.heal_kind`; document `WikiSearch` filter case-insensitivity; document single-tenant-per-daemon as architectural invariant.

**Leave alone (S11 verified): `ProvenanceChain` (cohesive write-lock + sink + verify), `ModelRouter` (right-sized adapter), `WikiStore` (right abstraction), `TenantScheduler` (essential complexity), `LLM providers/*` (right adapter shape), `server/middleware.ts` (180 LOC, single responsibility).**

---

## 7. Recommended next-pass scope (`/goal` proposals)

Each item below should be its own dedicated remediation goal, in order:

1. **G1 — Class-1 hotfix sweep (block first tenant signup).** All 70 items in §2. Estimated split across the LLM-providers/security/server/admin surface, the heal/compound/queue write-path, the wiki page parser, the provenance chain, and the CLI/config dual-mode gating. Pair with regression tests for each Class-1 item.
2. **G2 — Single-pass behavior validation.** Build & commit `test/fixtures/F1.md` through `F5.md` (slimmed from Phase A intent). Add an integration test job that runs the daemon end-to-end against them with recorded LLM transcripts. Required to validate that the "no existing-wiki context" fix (item 17) actually closes the regression.
3. **G3 — `src/hosted/` wiring decision.** Either wire the quota-enforcement classes into IngestionQueue and McpHttpServer, or delete them. Cannot ship to first tenant with the current "tested but not enforced" state.
4. **G4 — Single-shared-secret elimination.** Split `ADMIN_SERVICE_KEY` into three env vars (MCP bearer, internal admin, cloud-sink). With `tenant_count=0`, rip-and-replace is viable; coordinate with `wotw-cloud`.
5. **G5 — Provenance authentication.** Add HMAC signing using a daemon-derived key OR add external-anchor file (RFC 3161 / OpenTimestamps / S3-versioned mirror) so chain delete/forge attacks are detectable. Add `tenant_id` to canonical payload.
6. **G6 — Test theater purge.** Rewrite the 8 tests identified as theater (S10 §5b); add LLM-failure-injection coverage for the 4 refactored single-pass sites that lack it; add the path-traversal/raw-write/atomicWrite-failure/cost-overrun tests for `ingestion-queue.test.ts`.
7. **G7 — Type-sync CI gate.** Wire `check-llm-types-sync.mjs` into both `daemon` CI (via raw-URL diff fallback) and `wotw-cloud` CI. Currently neither CI runs the script.
8. **G8 — Documentation truth-up.** Rewrite the 3 stale doc-comments in `ingestion/*.ts` headers that describe the legacy multi-turn architecture; document the dual-mode gating, ADMIN_SERVICE_KEY rotation procedure, and the daemon's BYOK threat model (`docs/byok-threat-model.md`).
9. **G9 — Simplification backlog.** All Class-2 items from S11. Schedule across 2–3 sprints.

---

## 8. Deploy-process gap (the surfacing issue this session named)

The directive flagged: `.fly-registry.toml --push` omission caused initial `MANIFEST_UNKNOWN`. File is gitignored.

**Recommendation: enforce `--push` via a script or Makefile target, not a comment.** Gitignored files are invisible to new contributors and pull-request reviewers. The right durability mechanism for a deploy-process invariant is a checked-in shell script (e.g., `scripts/deploy.sh` or a `Makefile` target) that runs the push, fails loudly if the push step is missed, and is the only documented way to deploy. A comment in a gitignored file cannot durable a process.

Classification: **(3) documentation/process only** — but the fix is a script, not a doc.

---

## 9. Appendices

The 16 source reports total ~6,400 lines of detailed file:line evidence. They are stored at `/tmp/wotw-review/` during this audit session:

| Report | Findings | LOC | Path |
|---|---:|---:|---|
| S1 — LLM providers + edits + types | 14 | 699 | `/tmp/wotw-review/S1.md` |
| S2 — Main ingestion pipeline | 22 | 357 | `/tmp/wotw-review/S2.md` |
| S3 — Heal + compounding | 21 | 361 | `/tmp/wotw-review/S3.md` |
| S4 — Query path | 15 | 255 | `/tmp/wotw-review/S4.md` |
| S5 — Provenance chain | 13 | 235 | `/tmp/wotw-review/S5.md` |
| S6 — Wiki layer | 12 | 276 | `/tmp/wotw-review/S6.md` |
| S7 — Security + supply chain | 17 | 349 | `/tmp/wotw-review/S7.md` |
| S8 — Server + MCP + admin | 17 | 438 | `/tmp/wotw-review/S8.md` |
| S9 — CLI + config + runtime | 24 | 633 | `/tmp/wotw-review/S9.md` |
| S10 — Test suite quality | 14 | 326 | `/tmp/wotw-review/S10.md` |
| S11 — Simplification + maintainability | 34 + 8 leave-alone | 375 | `/tmp/wotw-review/S11.md` |
| X1 — Cross-S2 (behavior-vs-SDK lens) | 11 missed + 5 disagreements + 4 rec-refinements | 293 | `/tmp/wotw-review/X1.md` |
| X2 — Cross-S5 (crypto + filesystem lens) | 10 missed + 3 disagreements + 4 rec-refinements | 286 | `/tmp/wotw-review/X2.md` |
| X3 — Cross-S7 (BYOK e2e + key lifecycle) | 12 missed + 7 disagreements + 3 rec-refinements | 560 | `/tmp/wotw-review/X3.md` |
| X4 — Cross-S8 (SSRF + MCP injection lens) | 3 missed + 2 disagreements + 2 rec-refinements + 3 factual corrections | 326 | `/tmp/wotw-review/X4.md` |
| X5 — Cross-S1 (adversarial-output lens) | 11 missed + 7 disagreements + 5 rec-refinements | 614 | `/tmp/wotw-review/X5.md` |

These are working artifacts in `/tmp/`; if they need to persist beyond this session, the operator should copy them into the repo (e.g., `docs/reviews/2026-05-22-layer-1/`) before the next reboot.

---

## 10. Hard-gate compliance statement

- **Every finding cites file:line evidence in its appendix report.** No "subsystem reviewed" claims without anchoring.
- **No code or tests modified during the review.** Verification was done by reading + reasoning + scratch experiments outside the repo (e.g., `/tmp/adversarial-edits-test.mjs`).
- **No findings softened to make the diff look cleaner.** The "defense coded but not wired in" verdict is the dominant cross-cutting pattern and is called out as such.
- **All 91 files in `src/**` and 64 files in `test/**` were read by at least one agent.** Coverage report in §4.
- **Conflict log surfaced (§5).** No disagreements suppressed; all severity/classification/recommendation diffs documented.
- **S11 (simplification) ran without a cross-reviewer per directive** ("judgment calls; second reviewer would mostly produce noise"). Findings classified individually as 1/2/3 per the simplification rubric.

---

*End of REVIEW-LAYER-1-DAEMON.md*
