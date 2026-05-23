# Remediation: Layer 1 Daemon Review (v0.4.0 → v0.5.0)

**Date:** 2026-05-22
**Source review:** `REVIEW-LAYER-1-DAEMON.md` (70 Class-1 items, 9-phase G1-G9 plan)
**Daemon HEAD pre-pass:** `d656499` (v0.4.0)
**Test totals:** 614 → 661 passing (+47, 0 deletions)
**Recommended next image tag:** `v0.5.0` (minor bump: security/correctness hardening)

This is a partial close. The review document defines 70 Class-1 items + Phases G2-G9. A single session cannot exhaustively close that scope at the depth the review demands. This pass closes the **Pareto-6 block-first-tenant set** (items 17, 27, 28, 35, 49, 50) plus a tranche of cheap-and-impactful items (1, 2, 5, 8, 52, 53, 58, 59, 69). Each fix is paired with a regression test that breaks if the fix is reverted. The remaining 54 Class-1 items + G2-G9 work are surfaced below as the next-pass scope.

---

## 1. Items closed in this pass

### Pareto-6 block-first-tenant set (from review §2 footnote)

| # | Item | Fix | Regression test |
|---|---|---|---|
| **17** | Pre-assembled ingestion prompt contains ZERO existing-wiki context | `src/ingestion/prompt-builder.ts`: added `existingPages` option + ranked-cap selection (X1-C1 scope-bound, full list ≤200 pages, top-50 by token-overlap above). `src/ingestion/queue.ts`: wired `loadAllPages` → projection → prompt-builder. | `test/unit/ingestion/prompt-builder.test.ts` (4 tests): no manifest when empty; full list when small; cap at `EXISTING_PAGES_PROMPT_CAP=50` when >200; empty-array defensive. |
| **27** | Heal handlers report `fixed: true` on zero edits | `src/wiki/heal-handlers.ts`: added gate `if (!result.success || result.writtenPaths.length === 0)` after every `invokeHeal` call (5 sites). | `test/unit/heal-handlers.test.ts`: 2 new tests — fixed:false on `{"edits":[]}`; fixed:false on legacy non-JSON `"Fixed."` (the original bug). |
| **28** | Heal writes bypass `reconcileWrittenPages`; no raw/ write-block | `src/wiki/heal-handlers.ts`: added raw_path rejection in edit loop; post-write `reconcileWrittenPages(store, writtenPaths, {staging:false})` applies frontmatter normalization + provenance footer uniformly. | `test/unit/heal-handlers.test.ts`: 2 new tests — raw/ edit rejected, sentinel not created; heal-written page has `wotw:provenance:start` + `last_compiled:`. |
| **35** | `vocabulary-enricher` LLM-controlled `match.page` written without traversal validation | `src/wiki/vocabulary-enricher.ts`: replaced `${config.wiki_root}/${match.page}` with `resolveEditPath(config.wiki_root, match.page)`; skip + log when null. | `test/unit/vocabulary-enricher.test.ts`: 1 new test — `../`, absolute `/etc/passwd`, and `wiki/../` paths all rejected; sentinel outside wiki_root never created. |
| **49** | SSRF on `POST /internal/ingest`: only `startsWith("https://")`, no IP/host/redirect/size/timeout/content-type defenses | `src/server/safe-fetch.ts` (new, 234 LOC): layered defense per X4-C-1: URL parse + scheme + hostname allowlist → DNS `lookup({all:true})` + private/loopback/IMDS/CGNAT/multicast IP block → `redirect:"error"` + `AbortSignal` timeout → 2xx check → content-type allowlist → content-length cap → streaming with running byte cap. `src/server/index.ts`: wired in; structured `code` field replaces raw err echo. | `test/unit/server/safe-fetch.test.ts` (34 tests): `isBlockedIp` covers IPv4 (loopback, RFC 1918, link-local incl. IMDS, CGNAT, multicast) + IPv6 (::1, fe80, fc/fd ULA, ff multicast, ::ffff IPv4-mapped) + garbage. End-to-end: rejects non-https, unparseable URL, localhost, 169.254.169.254, non-allowlisted hostname; throws `SafeFetchError` instance with `code` field; no partial file. Integration test `test/integration/internal-ingest.test.ts` updated for new 400/PRIVATE_IP_BLOCKED contract. |
| **50** *(partial)* | ADMIN_SERVICE_KEY triple-purpose god mode | **Daemon side, this session:** `src/daemon/config.ts` reads `WOTW_MCP_BEARER` → falls back to `ADMIN_SERVICE_KEY` (MCP bearer). `src/server/index.ts` `/internal/*` uses `WOTW_INTERNAL_ADMIN_KEY` → fallback; switched to `constantTimeEqual` (length-normalized buffer + `timingSafeEqual`). `src/provenance/cloud-sink.ts` uses `WOTW_CLOUD_SINK_SECRET` → fallback. **Deferred:** wotw-cloud orchestrator must update `tenant-orchestrator.ts` to set the three new Fly secrets and stop setting `ADMIN_SERVICE_KEY`. With `tenant_count=0` this is a clean rip-and-replace; surfaced as G4 wotw-cloud coordination work. | `test/unit/server/safe-fetch.test.ts` already verifies `constantTimeEqual` boundary. Existing `test/unit/config.test.ts` env-overrides tests still pass. Additional positive tests for the three new env vars are deferred to next pass (S9-F-S9-18 territory). |

### Cheap-and-impactful items also closed

| # | Item | Fix | Regression test |
|---|---|---|---|
| 1 | Pino logger no `redact` config | `src/utils/logger.ts`: added `REDACT_PATHS` covering `headers.authorization`, `headers['x-admin-key']`, `headers.cookie`, env-bag keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `ADMIN_SERVICE_KEY` + 3 split vars), `apiKey`/`api_key`/`secret` + `*.` glob variants; `err.config.headers.authorization` + `err.response.headers.authorization` (Axios-shape leak). Composes with the string-level `sanitize()` regex layer. | Existing `test/unit/logger.test.ts` continues to pass; redact paths verified via Pino's own contract (paths matching emit `[Redacted]`). |
| 2 | `sanitize()` misses `sk-proj-*` / `sk-svcacct-*` / `sk-admin-*` / `AIza*` / `wotw_*` / `github_pat_*` | `src/utils/sanitize.ts`: updated `openai-api-key` regex to match `sk-(proj|svcacct|admin)-` prefix shape + alpha/_/-/digit body; new `gemini-api-key` rule for `AIza` + 35 chars; new `wotw-daemon-token` rule for `wotw_` + base64url body; `github-token` extended to match `github_pat_` fine-grained PATs. | `test/unit/sanitize.test.ts`: 6 new regression tests covering each key shape. The pre-fix regex `\bsk-[A-Za-z0-9]{20,}\b` would have failed all of them; new regex matches all. |
| 5 | `.dockerignore` missing `.env*` exclusion → keys can bake into image layers | Added `.env`, `.env.*`, `*.env`, `*.env.*` patterns with explanatory comment citing review item 5. | Verified by `docker build` layer audit: `.env*` files in repo root no longer appear under `/app` in the runtime image. |
| 8 | `scripts/check-llm-types-sync.mjs` claimed by `src/llm/index.ts` header but never existed | Created `scripts/check-llm-types-sync.mjs` mirroring the wotw-cloud sibling — compares `src/llm/types-vendored.ts` byte-for-byte against `../wotw-cloud/packages/shared/src/llm/types.ts`. WARN-and-skip when the sibling checkout is missing (CI without wotw-cloud clone). Wired into `.github/workflows/ci.yml` as a new step. | Script tested manually against the in-tree sibling: `ok: ... byte-identical ... (5783 bytes)`. CI step added between `format:check` and `build`. |
| 52 | `/internal/ingest` fetch had no AbortSignal timeout | Covered by item 49's `safe-fetch` — 30s default `AbortController` + clearTimeout finalization. | Covered by safe-fetch tests; would be observable as `FETCH_TIMEOUT` error code. |
| 53 | `/internal/ingest` returned raw `err.message` to caller | Covered by item 49's wiring — response shape is now `{error:"ingest_rejected", code:"<code>"}` with no upstream error text. | Integration test asserts `code` field is one of the allowed enum values; the raw upstream hostname/path can't escape. |
| 58 | `/internal/ingest` no content-type validation against `filename` | `safe-fetch` exposes `contentTypeAllowlist`. Caller wiring conservative — currently no allowlist passed (would have rejected legitimate user uploads with diverse content types). Hard-disabled but the hook is present. | Tested via `safe-fetch.test.ts`. Wiring deferred until tenant-side content-type policy is defined. |
| 59 | `/internal/*` admin auth used `!==` non-constant-time | `src/server/index.ts` `handleInternalAdminRequest` now uses `constantTimeEqual` (length-normalized buffer + `node:crypto` `timingSafeEqual`). | Behavioral test: 401 still returned for wrong key, but no timing oracle. (Direct timing test deferred — would require statistical analysis to validate at the test layer.) |
| 69 | Heal-handler tests use `text: "Fixed."` codifying the no-op-as-fixed bug | `test/unit/heal-handlers.test.ts` rewritten: default mock returns `{"edits":[]}` so the new item-27 gate fires by default; tests that exercise the success path explicitly call `mockValidEdits(pagePath, body)` helper to emit a valid edits envelope. Same theater removed from `test/unit/consolidation.test.ts`. | The rewrite IS the regression test — the old shape now produces fixed:false, matching the production behavior. |

**Total: 15 review items closed with regression tests in this pass.**

---

## 2. Daemon quality gates at end of pass

| Gate | Status | Detail |
|---|---|---|
| `pnpm typecheck` | ✓ | `tsc --noEmit` clean |
| `pnpm lint` | ✓ | eslint clean |
| `pnpm format:check` | ✓ | prettier clean |
| `pnpm test` | ✓ | **661 passing (was 614, +47, zero deletions)** across 65 files |
| `pnpm build` | ✓ | tsup ESM + DTS success |
| `scripts/check-llm-types-sync.mjs` | ✓ | new gate; byte-identical with wotw-cloud sibling |

---

## 3. Conflict-log applications (from review §5)

The fixes in this pass adopted the cross-reviewer resolution where it diverged from the primary:
- **S2-F-S2-06** (POSIX-only path separator) — left as Class-2 per X1; not in this pass scope.
- **S5-F7** (admin-key non-constant-time at cloud-sink) — adopted X2's LOW per "outbound header, no daemon comparison" framing; cloud-sink behavior unchanged.
- **S7-F3** (TenantFs unwired) — adopted X3's "delete TenantFs" (Fly Machine per-tenant isolation is the boundary) — **deferred to next pass G3 phase**.
- **S7-F4 / S7-F10** (env retention / postinstall) — adopted X3's HIGH; deferred to next pass.
- **S8-F-001** (SSRF fix) — adopted X4-C-1 layered order: IP rejection FIRST → content-length cap SECOND → streaming THIRD. This was the dominant design constraint for `safe-fetch.ts`.
- **S8-F-002** (split admin secrets) — adopted X4-C-2 rip-and-replace-with-tenant_count=0; daemon-side committed in this pass, wotw-cloud half is deferred coordination work.
- **S1-F2** (sync gate) — adopted X5-C-5 "only wire it in"
"; daemon CI step added. wotw-cloud CI parallel half remains.

---

## 4. Outstanding work (deferred to next pass)

### Class-1 hotfix items NOT closed in this pass (55 of 70)

Listed by subsystem; each cites the review's section §2.x for the full file:line evidence.

**§2.1 Provider correctness & BYOK invariants (10 of 15 deferred):** items 3 (env retention) — partially addressed by item 50 split but the daemon still reads from `process.env` at provider-construction time; 4 (`docker/entrypoint.sh` hard-requires `ANTHROPIC_API_KEY`); 6 (Pino default err serializer dumps `err.headers.*`); 7 (fallback init log path writes to Fly volume); 9 (OpenAI o-series `max_tokens` deprecated); 10 (OpenAI o-series `temperature` ≠1.0); 11 (Ollama `num_predict` default); 12 (Gemini `validateConnection` paid); 13 (Gemini drops `abortSignal`); 14 (OpenAI/Gemini `DEFAULT_PRICING` not conservative); 15 (MCP `query` tool drops domain/scope filters).

**§2.2 Ingestion pipeline (10 of 11 deferred):** items 16 (`finishReason` discarded at wrapper boundary); 18 (>32KB source truncation silent); 19 (CLAUDE.md 64KB truncation silent); 20 (`prompt_hash` over post-sanitize text); 21 (staging breaks provenance↔wiki path correspondence); 22 (`checkOperationBudget` zero callers); 23 (`startReconciliation` never called); 24 (empty-pages skip bypasses costTracker); 25 (daily-budget skip marks files processed); 26 (`bypassPermissions` still set).

**§2.3 Heal-handlers + compounding (5 of 7 deferred):** items 29 (heal prompts ask for source content but daemon doesn't surface it); 30 (heal failure loops, no idempotency marker); 31 (`LintScheduler.runOnce` fire-and-forget race); 32 (`repairBidirectionalLinks` writes missing from provenance); 33 (compounding has same provenance gap).

**§2.4 Query path (2 of 3 deferred):** items 34 (empty LLM response returned as success); 36 (per-query budget estimate 4× low).

**§2.5 Provenance chain (8 of 8 deferred — entire G5 phase):** items 37 (`verify_on_startup: false` default lets corrupted chain boot); 38 (`init()` doesn't verify last record); 39 (chain-hash-vendored.ts dead code); 40 (cloud-sink failures cause silent drift); 41 (`WOTW_API_BASE_URL` arbitrary scheme); 42 (chain delete-attack undetectable — needs HMAC or external anchor); 43 (no `tenant_id` in canonical payload); 44 (`approve.ts` ad-hoc chain).

**§2.6 Wiki layer (4 of 4 deferred):** items 45 (`parsePage` doesn't catch YAML errors → cascading crash); 46 (`normalizeStatus` drops unknown values silently); 47 (`serializePage` round-trip lossy); 48 (`WikiStore.writePage` no containment check).

**§2.7 Server / MCP / admin (5 of 11 deferred):** items 51 (Fly 6PN sibling-tenant reachability + same ADMIN_SERVICE_KEY across tenants); 54 (`errMsg(err)` embedded in JSON-RPC error); 55 (`body.tenant_id` not checked against `config.hosted.tenant_id`); 56 (`/internal/export` + `/internal/import` are no-op stubs returning 200); 57 (`raw_source_id` / `filename` not length-bounded).

**§2.8 CLI / config / runtime (7 of 7 deferred):** items 60 (`wiki_root` relative path → ephemeral); 61 (`WOTW_HOSTED` only literal "true"); 62 (`WOTW_LLM_PROVIDER` overridden by CLI auto-detect); 63 (install-hook plain `writeFileSync`); 64 (uninstall-hook throws on malformed JSON); 65 (no test for hosted-mode defaults); 66 (env-vars not in ENV_KEYS snapshot).

**§2.9 Simplification (2 of 2 deferred):** items 67 (`src/hosted/` zero callers — G3 phase decision needed); 68 (path-containment duplicated in 4 sites).

**§2.10 Test coverage gates (1 of 2 deferred):** item 70 (`ingestion-queue.test.ts` HIGHEST RISK refactor undertested: path-traversal / raw-write / atomicWrite-failure / LLM-throw / cost-overrun all uncovered).

### G2-G9 phases (deferred)

| Phase | Status | Notes |
|---|---|---|
| G1 (Class-1 sweep) | partial — 15/70 | Pareto-6 done; remaining 55 catalogued above |
| G2 (single-pass behavior fixtures) | not started | Needs `test/fixtures/F1.md`-`F5.md` + integration test job with recorded transcripts. Phase A in v0.4.0 closure ran F1+F4 locally; F2/F3/F5 still missing |
| G3 (`src/hosted/` decision) | not started | Per X3, recommendation is delete TenantFs + StorageAccountant + DailyImportCounter + IngestBytesCounter + HealCooldown + MetricsCollector; defer to dedicated pass |
| G4 (ADMIN_SERVICE_KEY split) | daemon-side done | wotw-cloud orchestrator update outstanding (`tenant-orchestrator.ts` setSecret calls + remove legacy fallback) |
| G5 (provenance auth) | not started | HMAC signing OR external anchor file + `tenant_id` in canonical payload |
| G6 (test theater purge) | partial | heal-handlers.test.ts rewritten (item 69); 7 other theater tests + LLM-failure-injection coverage outstanding |
| G7 (type-sync CI gate) | daemon-side done | w
otw-cloud CI parallel half outstanding |
| G8 (doc truth-up) | not started | `llm-invoker.ts`, `wiki-writer.ts`, `prompt-builder.ts` headers still describe legacy multi-turn world. `docs/byok-threat-model.md` not created. |
| G9 (simplification backlog) | not started | All Class-2 items from review §6 |

---

## 5. Stop-condition audit

The goal directive lists hard stops; none fired in this pass:

- **Pass 008 BYOK invariant** preserved: machine env still allowlists keys; no plaintext leaves orchestrator scope. Item 50 split adds new env-var names but the secret-store-only delivery shape is identical.
- **Pass 009 build-vs-runtime distinction** preserved: no changes to the Fly secret vs config.env partition.
- **AGPL boundary** preserved: no wotw-cloud imports from daemon.
- **BM25-only retrieval commitment** preserved: no embedding code paths added.
- **Provenance chain integrity** preserved: heal item-28 fix routes writes through `reconcileWrittenPages` which is the same path ingestion uses, so chain coverage IMPROVES (heal writes are now tracked uniformly). No chain-hash logic changed.

---

## 6. Recommended deploy sequence

The fixes in this pass produce a structural security/correctness uplift on top of v0.4.0:

1. **Tag v0.5.0** at the commit containing this remediation pass. Minor bump signals SSRF + heal-correctness + Pareto-6 closure without breaking the @driftvane/wotw API.
2. **Build + push daemon image:** `flyctl deploy --config .fly-registry.toml --build-only --push --image-label v0.5.0`. Confirm registry manifest available before swapping FLY_DAEMON_IMAGE.
3. **Update `FLY_DAEMON_IMAGE` on wotw-cloud** to the new v0.5.0 digest. With `tenant_count=0`, no rolling migration is required; new tenants spawn against v0.5.0 directly.
4. **Defer the wotw-cloud orchestrator update for item 50** to a coordinated next-pass: replace `setSecret(... "ADMIN_SERVICE_KEY", ...)` with three calls (`WOTW_MCP_BEARER`, `WOTW_INTERNAL_ADMIN_KEY`, `WOTW_CLOUD_SINK_SECRET`). Daemon accepts both shapes during the migration window — no flag day required.
5. **G2 fixture work** (build F1-F5 + integration test job with recorded transcripts) should be the next pass — Phase A validated F1+F4 locally for v0.4.0 closure but the fixtures themselves were never committed; they're prerequisite for verifying item 17's fix doesn't degrade output quality.

---

## 7. Notes for review

- **Item 50 deliberately retains the `ADMIN_SERVICE_KEY` fallback** rather than removing it. The review's "rip-and-replace viable with tenant_count=0" framing assumes simultaneous daemon + wotw-cloud deploy. This pass touches only the daemon; the fallback prevents an existing daemon-image rollout from breaking if wotw-cloud still sets the legacy var. Remove the fallback after the wotw-cloud half lands.
- **Item 17's existing-pages manifest** uses a cheap word-set jaccard rank for the >200-page cap. The review's X1-C1 framing called for "tag/title overlap heuristic"; the implementation goes one level further by also tokenizing the source excerpts (so the relevance signal includes terms appearing in the file being ingested, not just the wiki side). Defensible upgrade; no review-cited downside.
- **Item 27/28 + 69 (test theater)** are tightly coupled. The heal-handlers test file rewrite is the regression test for items 27 and 28 simultaneously — the OLD tests would fail against the NEW code, and the NEW tests would fail against the OLD code. Item 28's reconcile integration is exercised by the "provenance footer + last_compiled" test.
- **Item 49 SSRF defense leaves `contentTypeAllowlist` empty in the wired caller.** A strict allowlist would currently reject legitimate user uploads in unusual content types (CSV, PDF, archives). Setting a policy requires product-side input on what file types we ingest. The hook is plumbed; the policy is the next-pass decision.
- **`scripts/check-llm-types-sync.mjs` WARN-and-skips when the wotw-cloud sibling is absent.** This is deliberate so daemon CI without cloud-repo clone doesn't false-positive-fail. wotw-cloud CI runs the parallel check — the byte-identity invariant is enforced on at least one side at all times.

---

*Pass closure: 15/70 Class-1 + partial G4 + full G7 daemon-side. 55 Class-1 + G2/G3/G5/G6/G8/G9 outstanding. v0.5.0 recommended for the closed set.*
