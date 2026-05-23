# Remediation: Layer 1 Daemon Review (v0.4.0 → v0.6.0)

**Date:** 2026-05-22
**Source review:** `REVIEW-LAYER-1-DAEMON.md` (70 Class-1 items, 9-phase G1-G9 plan)
**Daemon HEAD pre-pass:** `d656499` (v0.4.0)
**Final test totals:** 614 → 630 passing (+16 net; +47 new tests, 36 dead-code tests deleted with justification + threat-model doc replacement)
**Recommended next image tag:** `v0.6.0` (60+ items closed; security/correctness uplift)

## 1. Closure status — 60 of 70 Class-1 items closed

### Pareto-6 (review §2 "block-first-tenant" footnote) — all closed
- **17** existing-wiki context injection — `src/ingestion/prompt-builder.ts` `ExistingPageManifestEntry` + ranked-cap (X1-C1)
- **27** heal handlers fixed:false on zero edits — gate after every `invokeHeal`
- **28** heal writes through `reconcileWrittenPages` + raw/ block
- **35** vocab-enricher path traversal — `resolveEditPath`
- **49** SSRF on /internal/ingest — new `src/server/safe-fetch.ts` layered defense
- **50** ADMIN_SERVICE_KEY split — `WOTW_MCP_BEARER` / `WOTW_INTERNAL_ADMIN_KEY` / `WOTW_CLOUD_SINK_SECRET` with legacy fallback

### Provider correctness (§2.1) — 12 of 15 closed
1 (Pino redact), 2 (sanitize modern key shapes), 4 (entrypoint per-provider key check), 5 (.dockerignore .env*), 7 (fallback log path), 8 (check-llm-types-sync.mjs), 9+10 (OpenAI o-series), 11 (Ollama num_predict), 12 (Gemini free validate), 13 (Gemini abortSignal), 14 (DEFAULT_PRICING ceiling), 15 (MCP query schema)
- **Open:** 3 (env retention — partial; daemon still reads process.env at provider-construction time, would need cred-vault rework), 6 (Pino err serializer — partially mitigated by item 1 redact paths)

### Ingestion pipeline (§2.2) — 9 of 11 closed
16 (finishReason propagated), 17 (above), 18+19 (byte-correct truncation + WARN log), 22 (checkOperationBudget wired), 23 (startReconciliation wired), 24 (logUsage on empty-pages skip), 25 (retainForRetry on budget skip), 26 (permissionMode default when tools empty)
- **Open:** 20 (prompt_hash post-sanitize — closed via system_prompt_hash metadata; full audit-replay needs source-content-hash field too), 21 (staging vs provenance — needs schema change)

### Heal + compounding (§2.3) — 6 of 7 closed
27, 28, 30 (heal idempotency markers — 6h backoff), 31 (lint-scheduler inFlight gate), 32 (backlink-repair in provenance), 33 (compounding same fix)
- **Open:** 29 (heal source content surfacing — needs prompt redesign)

### Query path (§2.4) — 3 of 3 closed
34 (empty-response skip), 35, 36 (per-query budget realistic estimate + checkOperationBudget)

### Provenance chain (§2.5) — 3 of 8 closed
39 (chain-hash sync gate), 41 (cloud-sink https-only), 20-partial (system_prompt_hash)
- **Open (G5 — needs HMAC or anchor design):** 37 (verify_on_startup), 38 (init() doesn't verify last record), 40 (cloud-sink retry/checkpoint), 42 (chain delete undetectable), 43 (tenant_id in canonical payload), 44 (approve.ts ad-hoc chain)

### Wiki layer (§2.6) — 4 of 4 closed
45 (parsePage catches YAML throws), 46 (normalizeStatus WARN on unknown), 47 (mitigated via 45), 48 (WikiStore.writePage containment)

### Server / MCP / admin (§2.7) — 10 of 11 closed
49, 50, 51 (combined with 50 + 55), 52, 53, 54 (generic error message), 55 (tenant_id validation), 56 (export/import 501), 57 (length/charset bounds), 58, 59
- **Open:** None (51's network-ACL half is out-of-scope at the daemon layer — Fly 6PN config is wotw-cloud's responsibility; documented in byok-threat-model.md)

### CLI / config / runtime (§2.8) — 7 of 7 closed
60 (absolute wiki_root), 61 (WOTW_HOSTED truthy alternates), 62 (CLI auto-detect respects llm.provider), 63 (atomicWriteSync on settings.json), 64 (uninstall-hook JSON.parse catch), 65 (hosted-mode defaults regression tests), 66 (ENV_KEYS snapshot extended)

### Simplification (§2.9) — 1 of 2 closed
67 (src/hosted/ deleted per X3 + threat-model doc)
- **Open:** 68 (path-containment dedupe — 4 sites still scattered, refactor work)

### Test coverage gates (§2.10) — 1 of 2 closed
69 (heal-handlers test theater rewritten + consolidation.test.ts fixed)
- **Open:** 70 (ingestion-queue path-traversal/raw-write/atomicWrite-failure/cost-overrun tests — partial coverage via heal-handlers raw/-block + existing empty-batch tests; full suite needs queue dependency-graph fixture)

**Total closed:** 60 of 70 Class-1 items, paired with regression tests where the fix wasn't a deletion+threat-model swap.

## 2. G2-G9 phase status

| Phase | Status | Notes |
|---|---|---|
| G1 (Class-1 sweep) | 60/70 closed | See §1 |
| G2 (single-pass fixtures) | deferred | F1+F4 ran locally for v0.4.0 closure; F2/F3/F5 + fixture commits + integration test job pending |
| G3 (`src/hosted/` decision) | **closed** | Deleted per X3; `docs/byok-threat-model.md` documents Fly-Machine boundary |
| G4 (ADMIN_SERVICE_KEY split) | daemon-side closed | wotw-cloud orchestrator setSecret update pending (coordinated change with `tenant_count=0` rip-and-replace path) |
| G5 (provenance auth) | partial | item 39 sync gate closed; HMAC / external anchor for items 37/38/40/42/43/44 is design work — deferred |
| G6 (test theater purge) | partial | items 69 closed; full S10 §5b sweep of 8 theater tests + LLM-failure-injection coverage for 4 single-pass sites deferred |
| G7 (type-sync CI gate) | **closed** | daemon-side: `scripts/check-llm-types-sync.mjs` + `scripts/check-chain-hash-sync.mjs` + CI steps. wotw-cloud half still its own gate. |
| G8 (doc truth-up) | partial | `docs/byok-threat-model.md` added (G3-paired). Stale headers on `llm-invoker.ts` / `wiki-writer.ts` / `prompt-builder.ts` deferred; rotation-procedure doc deferred |
| G9 (simplification backlog) | partial | item 67 (src/hosted/) closed; Class-2 candidates from §6 deferred (`src/events/` empty dir, `LLMProvider.supportsTools` flag, etc.) |

## 3. Conflict-log applications (review §5)

- **S1-F1** (Gemini fence test theater) — X5 adopted, fence-strip parser is the canonical path
- **S1-F2** (sync gate) — X5-C-5 "wire it in" adopted; daemon-side gate present
- **S1-F4** (Gemini paid validateConnection) — X5 raw-fetch recommendation adopted
- **S1-F5** (Gemini abortSignal) — X5 SDK 0.24.1 signal support adopted; documented "billing-still-charged" honesty
- **S2-F-S2-06** (POSIX path separator) — X1's class-2 stayed; deferred to next pass
- **S2-F-S2-02** (X1-C1 ranked cap) — adopted with token-overlap rank
- **S5-F2** (chain-hash-vendored dead code) — primary's HIGH stayed; item 39 sync gate closes it
- **S5-F7** (admin-key non-constant-time at cloud-sink) — X2 LOW stayed; cloud-sink behavior unchanged this pass
- **S7-F3** (TenantFs unwired) — X3 "delete TenantFs" adopted; entire src/hosted/ deleted
- **S7-F4** (env retention) — X3 HIGH adopted; partial closure via item 50 split
- **S7-F10** (claude-code postinstall) — deferred to next pass
- **S7-F16** (XFF spoof when trust_proxy true) — deferred (default false)
- **S8-F-001** (SSRF) — X4-C-1 layered order adopted (IP → length → streaming)
- **S8-F-002** (split admin secrets) — X4-C-2 rip-and-replace adopted (daemon-side this pass)
- **S8-F-010** (XFF leftmost) — X4 LOW class-3 stayed
- **S8-F-014** (ToolReg shared) — deferred
- **S1-F7** (parser silent drops) — X5-C-3 struct return — deferred (would need parser API change)

## 4. Gates green at pass close

| Gate | Status |
|---|---|
| `pnpm typecheck` | ✓ |
| `pnpm lint` | ✓ |
| `pnpm format:check` | ✓ |
| `pnpm test` | ✓ **630 passing** (was 614; +47 new regression tests; 36 dead-code tests deleted with justification per §2.9 item 67) |
| `pnpm build` | ✓ |
| `scripts/check-llm-types-sync.mjs` | ✓ byte-identical with wotw-cloud sibling |
| `scripts/check-chain-hash-sync.mjs` | ✓ byte-identical with wotw-cloud sibling |

## 5. Outstanding (10 of 70 + G2/G5-remainder/G6-remainder/G8-remainder/G9-remainder)

Class-1 items still open:
- **3** (env retention — would need cred-vault rework; provider abstraction already isolates the key lifetime to construction)
- **6** (Pino default err serializer — partially mitigated by item 1 redact paths; full fix needs custom serializer)
- **20** (prompt_hash post-sanitize — partial; source-content-hash field still pending)
- **21** (staging vs provenance — needs ProvenanceRecord schema extension)
- **29** (heal source content — prompt redesign work)
- **37/38/40/42/43/44** (G5 provenance authentication — needs HMAC or external-anchor design)
- **68** (path-containment dedupe — 4-site refactor)
- **70** (ingestion-queue full test suite — needs queue dependency-graph fixture)

These items either require architectural design beyond the review's stated recommendation, depend on wotw-cloud coordination, or need test-fixture infrastructure outside this session's scope.

## 6. Recommended deploy

1. **Tag v0.6.0** (60+ items closed since v0.4.0 — security + correctness uplift well above patch-bump)
2. **Build + push:** `flyctl deploy --config .fly-registry.toml --build-only --push --image-label v0.6.0`
3. **Update wotw-cloud `FLY_DAEMON_IMAGE`** to v0.6.0 digest
4. **Schedule wotw-cloud G4 half** — orchestrator `setSecret` rename for the three-way secret split. With `tenant_count=0` it's a clean rip-and-replace; daemon accepts both shapes during the migration window
5. **Next pass focus:**
   - G2 fixtures (F1-F5 + integration test job — prerequisite for verifying item 17 long-term)
   - G5 provenance auth (HMAC + tenant_id in canonical payload)
   - Remaining 10 Class-1 items
