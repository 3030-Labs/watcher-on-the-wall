# Reconciliation Pass — v0.2.0

**Date:** 2026-04-09
**Base commit:** `61202e8` (Feature Pass 003, 300 tests)
**Starting tests:** 337 (v0.2 sprint uncommitted)
**Final tests:** 356 across 37 files
**Gates:** typecheck clean, lint clean, format clean, 356/356 tests, build success

---

## Feature Status

| # | Feature | Status | Action Taken |
|---|---------|--------|--------------|
| 1 | Provenance Footers | Verified in place | No changes needed |
| 2 | `wotw search` CLI | Verified in place | No changes needed |
| 3 | Candidates Approve/Reject | Adapted | Staging integration: `reconcileWrittenPages` redirects to `candidates/`, rejection feedback in prompt builder, `wotw start --auto-approve`, `wotw init` scaffolds `candidates/` dirs |
| 4 | `wotw stale` CLI | Rewritten | Now wraps `computeHealthReport` from health.ts instead of parallel staleness system. `parseDuration`, `scoreThresholdForDuration` exported. |
| 5 | Getting Started page | Verified in place | No changes needed |
| 6 | Config Zod + Token chmod | Verified in place | No changes needed |
| 7 | X-Forwarded-For Proxy Trust | NEW | `server.trust_proxy: false` default. `extractClientIp` conditional on `trustProxy`. Closes F-8 audit finding. |
| 8 | Zero-Hit Grounding Guard | NEW | `QueryEngine.answer()` short-circuits on 0 search hits. No LLM call, $0 cost. |

---

## Files Touched

### Source files modified
- `src/utils/types.ts` — added `staging: boolean` to ingestion, `trust_proxy: boolean` to server
- `src/daemon/config.ts` — added defaults and Zod schema entries for `staging` and `trust_proxy`
- `src/server/middleware.ts` — `trustProxy` option, conditional XFF extraction
- `src/server/index.ts` — passes `trust_proxy` from config to middleware
- `src/server/query-engine.ts` — zero-hit grounding guard
- `src/ingestion/wiki-writer.ts` — `ReconcileOptions` with `staging`, redirect to `candidates/`
- `src/ingestion/queue.ts` — passes `staging` from config to reconciler
- `src/ingestion/prompt-builder.ts` — `loadRejectionFeedback()` reads `candidates/rejected/`
- `src/cli/commands/start.ts` — `--auto-approve` flag
- `src/cli/commands/init.ts` — scaffolds `candidates/` and `candidates/rejected/`
- `src/cli/commands/stale.ts` — complete rewrite wrapping health scoring

### Test files added
- `test/unit/staging.test.ts` (5 tests) — staging redirect, backward compat, rejection feedback
- `test/unit/query-engine.test.ts` (2 tests) — empty wiki, unmatched query

### Test files modified
- `test/unit/middleware.test.ts` (+3 tests) — trust_proxy true/false/shared-bucket
- `test/unit/config.test.ts` (+3 tests) — trust_proxy/staging validation
- `test/unit/stale-command.test.ts` (rewritten, 11 tests) — parseDuration, scoreThresholdForDuration, Dataview dashboard

### Documentation updated
- `docs/cli-reference.md` — added `search`, `stale`, `candidates`, `approve`, `reject` commands; `--auto-approve` flag on `start`; zero-hit note on `query`
- `docs/configuration.md` — added `ingestion.staging`, `server.trust_proxy` fields and feature notes
- `docs/architecture.md` — candidates staging section, zero-hit guard note, wiki structure diagram updated
- `BUILD-SUMMARY.md` — headline numbers, reconciliation gate

---

## Test Delta

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Test files | 35 | 37 | +2 |
| Tests passing | 337 | 356 | +19 |

### New tests (19)
- staging.test.ts: 5 (staging redirect, staging=false compat, staging=undefined default, rejection feedback, no feedback when empty)
- query-engine.test.ts: 2 (empty wiki zero-hit, unmatched query zero-hit)
- middleware.test.ts: 3 (trust_proxy false ignores XFF, trust_proxy true uses XFF, trust_proxy false shared bucket)
- config.test.ts: 3 (rejects non-boolean trust_proxy, rejects non-boolean staging, accepts valid values)
- stale-command.test.ts: 6 net new (rewritten from 5 to 11 tests)

---

## Gate Results

```
pnpm typecheck   → clean (0 errors)
pnpm lint        → clean (0 errors)
pnpm format:check → clean (0 diffs)
pnpm test        → 356/356 passing across 37 files (11.34s)
pnpm build       → ESM + DTS success
                   dist/cli/index.js     272.62 KB
                   dist/daemon/entry.js  178.62 KB
                   dist/index.js          24.71 KB
```
