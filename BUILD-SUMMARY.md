# BUILD-SUMMARY — watcher-on-the-wall v0.8.4

> ### PASS-023 — Daemon public-launch readiness — 2026-05-26
>
> Closes the onboarding-shell gap before DriftVane/watcher-on-the-wall
> flips public. 14 items across fresh-install evidence, README/docs
> rewrite, repo hygiene + policy docs (SECURITY/CHANGELOG/LICENSE-NOTICES/
> CONTRIBUTING/ISSUE_TEMPLATEs), Pack-format daemon-side spec, error-message
> audit on 10 unhappy paths, opt-in BYO-DSN telemetry. Implementation
> commits in this single ship chain.
>
> **Onboarding shell:**
> - `README.md` rewritten for first-60-second comprehension: tagline +
>   2-paragraph "what it is" + 5-line install + 30-sec quickstart with
>   concrete output + links to deeper docs. Note about npm publish-gap
>   window kept honest during the bounded window between repo public-flip
>   and v0.8.4 publish.
> - New docs: `init-walkthrough.md`, `self-hosted-byok.md`,
>   `llm-provider-auto-resolution.md`, `pack-format-daemon.md`,
>   `telemetry.md`, `install-evidence/` (README + macOS arm64 runbook
>   + 5 fixture markdown files).
> - `CHANGELOG.md` rewritten per-version user-visible (v0.7.0 Pass A
>   through v0.8.4 current); internal closure docs referenced not exposed.
> - `SECURITY.md` updated SLA (5 business days ack, 30 calendar days
>   fix-or-disclosure for high/critical) + explicit safe-harbor for
>   good-faith researchers + PGP key reference.
> - `LICENSE-NOTICES.md` (new) — AGPL-3.0 in plain English; derivative-work
>   test, network-use §13, wotw-cloud relationship, fork rules.
>   Attorney-disclaimable.
> - `CONTRIBUTING.md` rewritten — AGPL implications, DCO sign-off
>   (Developer Certificate of Origin), 7 quality gates, PR review SLAs,
>   bot-PR policy.
> - `.github/ISSUE_TEMPLATE/*.yml` migrated from legacy `.md` to GitHub
>   issue forms (bug_report / feature_request / question / config).
>
> **Code (new subsystems):**
> - `src/utils/actionable-error.ts` — `ActionableError` class +
>   10-path categorical constructor helpers + heuristic matchers
>   (native-binding load, permission-denied, file-lock, port-in-use).
>   CLI top-level handler at `src/cli/index.ts` renders these as
>   structured stderr blocks.
> - `src/telemetry/{types,sink,categorize,index}.ts` — opt-in BYO-DSN
>   Sentry breadcrumbs. **Disabled by default; no 3030 Labs DSN.**
>   Sentry SDK is an optional peer dep; sink falls back to no-op if
>   not installed. Validator rejects PII-shaped fields; categorical
>   events only (10 stable enum values).
>
> **Code (wraps at existing call-sites):**
> - `src/keys/store.ts` + `src/facts/store.ts` — better-sqlite3 binding
>   load wrapped with `looksLikeNativeBindingFailure` + `nativeBindingLoadError`.
> - `src/daemon/index.ts` — `ensureDirSync` calls wrapped with
>   `looksLikePermissionDenied` + `wikiDirPermissionError`. Daemon-already-running
>   path migrated to `daemonAlreadyRunningError`.
> - `src/daemon/config.ts` — cosmiconfig parse failures wrapped with
>   `configParseError`.
> - `src/server/index.ts` — port-bind error path wrapped with
>   `looksLikePortInUse` + `portInUseError`.
> - `src/cli/commands/init.ts` — OBSIDIAN_VAULT_PATH env var now honored;
>   non-empty-target collision detection added; init-failure pipe
>   routes through `recordInitFailure` to the telemetry sink.
>
> **CI:**
> - `.github/workflows/install-evidence.yml` — `workflow_dispatch`-only
>   (deliberate; tag-push-fires-workflow would race the publish step).
>   Matrix: macos-14 (arm64), macos-13 (amd64), ubuntu-22.04,
>   windows-2022. Each captures `npm install → wotw init → 5-file drop
>   → status` per-platform artifact for promotion into
>   `docs/install-evidence/`.
>
> **Tests: 929 passed (929) across 90 files** — 813 baseline + 116 new
> (38 actionable-error + 7 init-error-paths + 38 telemetry +
> existing-test isolation refactor). Crosses the ≥ 900 hard gate.
> All 7 build gates green: typecheck / lint / format / build / test /
> docs-in-sync / provenance-compat.
>
> **package.json metadata:**
> - version 0.8.3 → 0.8.4
> - homepage → https://wotw.dev (was GH repo URL)
> - keywords expanded for npm discovery
> - SECURITY.md / CHANGELOG.md / LICENSE-NOTICES.md added to `files`
>   array so they ship in the tarball
>
> **Irreversible-action sequencing (per goal-authorization-scope):**
> 1. ✅ Commit + push to main
> 2. ✅ `gh repo edit --visibility public`
> 3. ✅ Tag v0.8.4 + push
> 4. 🟡 Operator dogfood pass (next checkpoint)
> 5. 🟡 npm publish v0.8.4 (held behind dogfood gate)
> 6. 🟡 install-evidence workflow dispatched + 4 platform artifacts
>    captured + promoted
> 7. 🟡 Manual macOS arm64 capture committed
>
> Closure doc: `PASS-023-DAEMON-PUBLIC-READINESS.md`. Pass remains
> 🟡 substrate-complete until items 4-7 above land.
>
> ### PASS-019 — G5 Completion (KEK rotation + DEK auto-archive cron) + v0.8.3 ship — 2026-05-25
>
> Closes the two G5 items Pass 018 explicitly deferred: KEK rotation
> operation + the auto-archive cron that transitions rotating DEKs to
> archived after their overlap window. Implementation commit `9b86597`,
> image push commit chain follow-on.
>
> **Substrate (KEK rotation):**
> - `KeyStore.rotateKek(newKek)` — single SQLite transaction
>   re-encrypts every non-revoked DEK under the new KEK; cache clear
>   + `this.kek` swap happen post-commit. Atomicity verified:
>   mid-rotation throw rolls back rows + leaves `this.kek` unchanged.
> - `KeyStore.archiveOverlapped(workspaceId, overlapMs, now)` — bulk
>   variant of `archive()` filtered by `state='rotating' AND
>   rotated_at <= cutoff`. Idempotent, workspace-isolated.
> - CLI: `wotw workspace rotate-kek --confirm` + `wotw workspace
>   archive-overlapped` (manual cron trigger).
> - Runbook: `docs/policies/kek-rotation.md` with dual-secret pattern
>   for zero-downtime rotation, rollback scenarios, forbidden ops.
>
> **Substrate (auto-archive cron):**
> - `DekArchiveScheduler` implements `DaemonSubsystem`, mirroring
>   `LintScheduler`. Hourly tick, configurable via
>   `WOTW_DEK_OVERLAP_HOURS` env (default 24h). `unref()`'d timer.
>   In-flight guard + injectable `now` for tests.
> - Wired in `daemon/entry.ts` only when keyStore + workspaceId both
>   present (hosted mode + `WOTW_WORKSPACE_KEK`). Forward-compat with
>   v0.8.1 daemons: no-op subsystem when keystore absent.
>
> **Tests: 852 passed (852) across 87 files** — 813 baseline + 39 new
> (14 KEK rotation + 8 rotation-under-load + 12 scheduler + 5
> workspace-CLI wiring). HMAC overhead bench unchanged at 0.463ms p99
> (rotation is a separate, rare path; not in append's hot loop). All
> 7 daemon gates green.
>
> **v0.8.3 image shipped:**
> - **OCI index digest (pin in `FLY_DAEMON_IMAGE`):**
>   `sha256:4d26edff70043f565d8b61b5b357577a2e0fcd954620e064df89e23c94b95cd6`
> - **linux/amd64 manifest:**
>   `sha256:cd1a3b6a43889555ecd871f92161cd18e2120c6e3011840de93596a0fdf3b9f5`
> - Build-time SQL gate fired (`better-sqlite3 self-test passed`);
>   .node artifact present in pushed image; boot smoke
>   `/healthz` returned `version: 0.8.3` in 4s.
>
> Closure docs: `PASS-019-G5-COMPLETION.md` (this pass) +
> `docs/policies/kek-rotation.md` (operator runbook). Cloud handoff:
> two-stage rev bump (v0.8.2 first to activate substrate, then v0.8.3
> for rotation operations) OR pin v0.8.3 directly — v0.8.3 strictly
> supersedes.

> ### v0.8.2 Deployment — Image ship for Pass 018 G5 substrate — 2026-05-25
>
> Daemon v0.8.2 image built and pushed to
> `registry.fly.io/wotw-daemon:v0.8.2` from source HEAD `fb19cdb`
> (Pass 018 closure). Cloud's `FLY_DAEMON_IMAGE` rev bump consumes
> the manifest digest. **Part A of the PASS-019 directive closed.**
>
> - **Image tag:** `registry.fly.io/wotw-daemon:v0.8.2`
> - **OCI index digest (pin in `FLY_DAEMON_IMAGE`):**
>   `sha256:a40b1619f5cd8978169b2c738f305b8e31f09c0aa944b30d2c7be4a6ac4a6012`
> - **linux/amd64 image manifest:**
>   `sha256:72d91ed2d0cc7497c05e2eada1836fe8d6c38ceac71b906ef5a6ee28723298ee`
> - **Source HEAD:** `fb19cdb` (Pass 018 G5 closure, tag `v0.8.2`)
> - **Build timestamp:** 2026-05-25T02:54Z
> - **Build tool:** `docker buildx build --platform linux/amd64 --push`
>   (local Docker Desktop on WSL2, BuildKit v0.29.0). v0.8.1 native-dep
>   pattern preserved: `pnpm rebuild better-sqlite3` in build stage,
>   build-time SQL self-test gate in runtime stage.
> - **Smoke evidence (scope-expanded vs v0.8.0/v0.8.1):**
>   - Container `find /app -path '*better_sqlite3.node*'` → .node present ✓
>   - Throwaway container boot: `/healthz` returned
>     `{"ok":true,"name":"watcher-on-the-wall","version":"0.8.2"}` in
>     4 seconds (well under 60s budget)
>   - Deprovision clean
> - **G5 activation cloud-side:** v0.8.2 daemons spawn with G5
>   attestation ACTIVE only when `WOTW_WORKSPACE_KEK` is in env.
>   Without it, falls back to v0.8.1 single-key 4-tier HMAC.
> - **Gates:** all 7 green at HEAD `fb19cdb` — 813 passed (813).
>
> Closure doc: `SHIP-V0.8.2.md` (handoff to cloud /goal). Parts B+C
> of PASS-019 (KEK rotation + auto-archive cron) continue in the
> same goal; if both land, v0.8.3 follow-on image will ship.

> ### PASS-018 — G5 End-to-End Attestation Closure — 2026-05-24
>
> Closes CT1.01 🟡 PARTIAL → ✅. The Layer-1 G5 scaffolding (commit
> `1875925`) shipped HMAC + tenant_id + tail-verify hooks but left the
> substrate as a stub: single static key, no encryption-at-rest, no
> rotation, and `verify()` didn't actually validate HMACs. This pass
> ships the complete workspace-key substrate. Implementation commit
> `574d34f` — `feat(provenance-g5)` (v0.8.2).
>
> - **Workspace key lifecycle** via SQLite at `.wotw/keys.db` (schema v1
>   under `PRAGMA user_version`, same pattern as Pass B's facts.db).
>   States: `active → rotating → archived`, plus terminal `revoked`.
>   Partial unique index enforces at-most-one-active-per-workspace at
>   the DB level.
> - **Envelope encryption** (AES-256-GCM) with KEK in
>   `WOTW_WORKSPACE_KEK` Fly secret. Per-workspace DEKs encrypted under
>   KEK; plaintext only in process memory, never on disk, never logged.
> - **Attestation-on-append** wired: every record HMAC-SHA256 signed
>   with the active DEK; new `key_id` field stamped on the record but
>   excluded from canonical payload (same [[project-provenance-compat]]
>   pattern as `hmac` and `fact_hashes_*`).
> - **Tail-verify + full-verify** now validate HMACs via
>   `KeyStore.resolveById()` across all key states. Records signed
>   under a rotating, archived, or revoked DEK still verify
>   cryptographically; state is forensic.
> - **Mid-chain DEK rotation** with overlap window: `rotate()` is a
>   single atomic SQL transaction. Both old and new DEKs resolvable
>   for verify during overlap. Manual via `wotw keys rotate` CLI;
>   auto-archive cron deferred.
> - **`/internal/verify` HTTP endpoint** admin-keyed surface. Contract
>   frozen for the future `wotw-verify` Go CLI (CT5.01, separate pass).
> - **HMAC overhead**: 0.463ms p99 (under the 1ms budget). Append
>   latency dominated by fsync; HMAC compute is microseconds.
> - **813 tests passed (813)** across 83 files — 752 baseline + 61 new
>   (19 envelope + 24 store + 12 G5 attestation + 5 /verify integration
>   + 1 HMAC overhead bench). All 7 daemon gates green.
> - **Backward-compat** verified: pre-G5 chains (no `hmac` field) and
>   G5-scaffolding chains (`hmac`, no `key_id`) both verify under
>   v0.8.2 daemon. Latent bug fixed in `verify()` canonical-payload
>   walk: `tenant_id` now included (matches `append()` + `init()`
>   tail-verify which already included it).
> - **Forward-compat** verified at the hash level: v0.8.2 chain
>   canonical `id` matches what an older daemon would compute, because
>   `key_id` is excluded from canonical payload.
>
> Closure doc: `PASS-018-G5-CLOSURE.md`. Daemon image v0.8.2 not built
> in this pass — separate SHIP-V0.8.2 pass following the v0.8.1 ship
> pattern. CT1.02-CT5.03 + KEK rotation are downstream.
>
> Unblocks every Compliance-tier item that depends on real attestation
> (CT1.02 SKU, CT2.x retention, CT3.x redaction audit, CT4.x Compliance
> Pack export, CT5.x wotw-verify CLI).

> ### v0.8.1 Deployment — Patch ship (better-sqlite3 .node fix) — 2026-05-24
>
> Daemon v0.8.1 image built and pushed to
> `registry.fly.io/wotw-daemon:v0.8.1`, **superseding the broken v0.8.0
> image**. v0.8.0 (digest `sha256:4d13f66f...`) booted past the banner
> then crashed FATAL on FactStore construction with "Could not locate
> the bindings file" — the compiled `build/Release/better_sqlite3.node`
> was absent from the runtime image. v0.8.1 fixes the Dockerfile.
>
> - **Image tag:** `registry.fly.io/wotw-daemon:v0.8.1`
> - **OCI index digest (pin this in `FLY_DAEMON_IMAGE`):**
>   `sha256:f62d153fd598d68b8651aba5ca62180e6d7e229d39556b0fb2b7ecbda7a68d05`
> - **linux/amd64 image manifest digest:**
>   `sha256:b190cccf7dee989a7e37190db9daf44d06e69231538ed5825b386c0d69e06960`
> - **Build commits:** `e4d22ad` (`fix(docker): rebuild better-sqlite3
>   native binding`) + `7c7ca84` (`fix(docker): add python3+make+g++
>   to build stage for node-gyp fallback`). Source HEAD unchanged from
>   v0.8.0: `99d74ab`.
> - **Build timestamp:** ~2026-05-24T18:20Z
> - **Root cause:** Dockerfile's build stage runs
>   `pnpm install --ignore-scripts` (needed to bypass husky `prepare`),
>   which skipped better-sqlite3's `install: prebuild-install ||
>   node-gyp rebuild --release` lifecycle. The C++ source tree shipped
>   but no compiled `.node` artifact. Pass B added the better-sqlite3
>   dep without an explicit rebuild step (analogous to the pre-existing
>   handling for @anthropic-ai/claude-code's native binary).
> - **Fix shape:**
>   1. Add `python3 make g++` to the build stage's apt-get
>      (node-gyp fallback prerequisites; build-stage only, runtime
>      slim image unaffected).
>   2. Add `RUN pnpm rebuild better-sqlite3` after the install step.
>   3. Add runtime-stage `RUN node -e '<open + DDL + DML + SELECT>'`
>      as a build-time gate — image build fails BEFORE push if the
>      bindings can't load. Standing pattern for any future native dep.
> - **Smoke (scope-expanded vs v0.8.0):**
>   - Local proxy: `node dist/cli/index.js --version` → `0.8.1` ✓
>   - Container `find /app -path '*better_sqlite3.node*'` → `.node`
>     present at expected path ✓ (v0.8.0 returned empty)
>   - Container SQL exercise: `docker run ... node -e '<INSERT/SELECT>'`
>     → `ok: {"x":1}`, exit 0 ✓
>   - Build-time gate inside Dockerfile fires every build: ✓
> - **Gates:** all 7 green at HEAD `e4d22ad` — 752 passed (752).
>   Source unchanged from v0.8.0, baseline preserved.
>
> Closure doc: `SHIP-V0.8.1.md`. Cloud `FLY_DAEMON_IMAGE` rev bump
> handoff: pin the v0.8.1 OCI index digest, NOT the v0.8.0 digest
> (which is the broken one).

> ### v0.8.0 Deployment — Image pushed to Fly registry — 2026-05-24 [SUPERSEDED — broken]
>
> **Status: superseded by v0.8.1.** This image (digest
> `sha256:4d13f66f...`) is the broken one — boot reaches the banner
> then crashes FATAL on FactStore due to missing
> `build/Release/better_sqlite3.node`. See v0.8.1 entry above for the
> fix. v0.8.0 image is left in the registry for forensics but should
> NOT be pinned by `FLY_DAEMON_IMAGE` — the v0.8.0 ship pass's
> local-proxy smoke didn't exercise the container runtime, and the
> runtime-exercise residual was scope-limited to "first cloud-side
> spawn." That deferred gate caught the bug — at the cost of one bad
> tenant boot. **Lesson:** any native dep added after a daemon-only
> source-level smoke MUST get a corresponding container-level smoke
> in the ship pass itself. v0.8.1 codifies this via the Dockerfile's
> runtime-stage SQL exercise (build-time gated, can't ship without it).
>
> Original v0.8.0 ship-doc record retained below for forensics:
>
> - **Image tag:** `registry.fly.io/wotw-daemon:v0.8.0`
> - **OCI index digest (DO NOT PIN — broken):**
>   `sha256:4d13f66f756dc0618aafae7d869152570c06490ae1b8d1277184df6f300a52ac`
> - **linux/amd64 image manifest digest:**
>   `sha256:9b33b29b96113560dbaed9829e571bd1cda861948840d6af6b9bd7010caf79ff`
> - **Build commit:** `b1213de` (`chore(version): bump 0.4.0 → 0.8.0`).
>   Source HEAD at Pass B closure: `99d74ab`.
> - **Build timestamp:** 2026-05-24T14:45:26Z
> - **Build tool:** `docker buildx build --platform linux/amd64 --push`
>   (local Docker Desktop on WSL2, BuildKit v0.29.0)
> - **Smoke invocation (insufficient):** `node dist/cli/index.js
>   --version` → `0.8.0` (exit 0). This proved the source-version
>   surface compiled correctly but did NOT exercise the container.
>   Runtime entrypoint exercise was deferred to first cloud-side
>   tenant spawn (documented in `CONTEXT-EFFICIENCY-PASS-B.md`
>   §"Runtime-exercise residual"). The deferred gate caught the
>   missing-bindings bug — too late to prevent the bad ship.
> - **Gates:** all 7 green at HEAD `99d74ab` (pre-bump) and
>   `b1213de` (post-bump) — **752 passed (752)** across 78 files.
>   The Pass B test suite covered FactStore in unit tests (where
>   the local node_modules' compiled .node WAS present); did NOT
>   exercise FactStore inside the container. That gap is what
>   shipped the bug.
>
> Closure doc: `SHIP-V0.8.0.md` (now historical).

> ### Context-Efficiency Pass B — Fact-level retrieval + synthetic questions + provenance — 2026-05-23
>
> Pass B closes the foundational fact-extraction layer. Three feature
> passes (FP-008 fact extraction, FP-009 synthetic questions, FP-010
> lifecycle + provenance) plus a new MCP tool + Group A behavior
> extension + CLI command:
> - SQLite `.wotw/facts.db` (better-sqlite3) with idempotent
>   user_version=1 migration; FactStore stores (entity, statement)
>   pairs + synthetic questions, supersession via `superseded_at`.
> - FactIndex wraps two parallel minisearch instances (facts +
>   questions) and fuses scores weighted 0.4 + 0.6 — question shape
>   wins per Cambridge ALTA.
> - Extractor runs a single combined LLM call returning facts +
>   questions; gated cost-free by default (Ollama/Claude Code CLI
>   auto-active; metered providers opt-in via
>   `fact_extraction.force_enabled`).
> - New MCP tool `query_facts` ships 82.5%-98.7% fewer tokens than the
>   legacy `query` retrieval on atomic-question fixtures (F1 86.7% / F4
>   82.5% / small-corpus 84.5% / large-corpus 96.2%).
> - Group A tools (define / relate / cite_sources) now check the fact
>   layer first via FactIndex; each response carries a `source_layer`
>   field; Pass A contracts unchanged.
> - ProvenanceRecord extended with `fact_extracted` type +
>   `fact_hashes_added` / `fact_hashes_superseded` optional fields
>   (NOT folded into canonical payload — forward/backward compat
>   verified end-to-end).
> - Cost tracking metered under `operation_type:"fact_extraction"`.
> - New CLI command `wotw facts reindex` for existing-wiki migration.
>
> **747 tests** across **80 files** — 700 prior baseline + 47 new
> (43 unit + 4 benchmark assertions). All 7 daemon gates green.
> BM25-only commitment preserved (no new vector deps). Pass 008 BYOK
> preserved. AGPL boundary preserved (better-sqlite3 MIT). Schema +
> provenance forward/backward compat verified. **Live-API
> per-provider quality measurement is deferred per Phase-A pattern
> (irreducibly external) — documented as Group C precondition in
> CONTEXT-EFFICIENCY-PASS-B.md §5.** Recommended next roadmap step:
> Compliance tier (G5 chain attestation + audit export) — see §7.

> ### Context-Efficiency Pass A — Progressive retrieval + token-budget + narrow queries — 2026-05-23
>
> Six additive MCP tools shipped (FP-005 progressive, FP-006 token budget,
> FP-007 narrow-query) targeting client-LLM context efficiency:
> - `query_progressive` + `query_expand` — tier-based progressive retrieval
>   over BM25 hits (lede → snippets → section-ledes → full bodies), pure
>   structural (no daemon-side LLM call).
> - `estimate_query_cost` — pre-flight token estimate over the BM25
>   retrieval payload, with heuristic + Anthropic/Gemini native-tokenizer
>   paths.
> - `define` / `relate` / `cite_sources` — narrow primitives at small
>   token caps (256/768/512), intersection-based for `relate`,
>   provenance-record lookup for `cite_sources`.
>
> Benchmark: tier-0 ships **86-99% fewer tokens** than the legacy `query`
> retrieval payload on all four fixtures (F1-photosynthesis 95.3% /
> F4-rust-borrow-checker 94.9% / small-corpus 86.9% / large-corpus 98.6%).
> **693 tests** across **80 files** — 630 prior baseline + 63 new (56
> unit + 7 benchmark assertions). All 7 daemon gates green. BM25-only
> commitment preserved (regression-guard tests scan for vector imports).
> Pass 008 BYOK invariants preserved. AGPL boundary preserved (no
> wotw-cloud imports). See CONTEXT-EFFICIENCY-PASS-A.md for closure
> evidence + Group B sequencing.

> ### Multi-LLM Phase 10 — Per-tenant provider config + dispatch — 2026-05-22
>
> Daemon-side complete: `WotwConfig.llm.{provider, model, ollama_url}` added
> with defaults; hosted-mode env overrides `WOTW_LLM_PROVIDER` /
> `WOTW_LLM_MODEL` / `WOTW_OLLAMA_URL` wired (provider selection also
> remaps `execution.api_key_env` to canonical key var); `runtimeAwareComplete`
> dispatches to AnthropicProvider / OpenAIProvider / GeminiProvider /
> OllamaProvider based on config via new `selectProvider` switch.
> **609 tests** across **63 files** — 608 prior baseline + 1 new dispatch
> test. All 5 gates green.
> **Phase 10b (cloud-side BYOK extension in tenant-orchestrator) is
> deferred — concrete scope documented in MULTI-LLM-PHASE-010.md.**

> ### Multi-LLM Phases 7-9 — OpenAI / Gemini / Ollama Providers — 2026-05-22
>
> Three non-Anthropic providers all conforming to LLMProvider:
> - `OpenAIProvider` — `openai` SDK Chat Completions (gpt-4o/mini/o1/o1-mini/turbo)
> - `GeminiProvider` — `@google/generative-ai` SDK (gemini-2.0-pro/flash + 1.5)
>   with BLOCK_ONLY_HIGH safety defaults (strictSafety opt-in)
> - `OllamaProvider` — direct HTTP against localhost:11434, no SDK, no API
>   key, totalCostUsd always null; listModels() extension
> 28 new tests (10 OpenAI + 9 Gemini + 11 Ollama). All 3 providers
> register through src/llm/index.ts barrel. **608 tests** across **63
> files** — 580 prior + 28 new. All 5 gates green. **Live
> cross-provider regression (95% schema conformance) is deferred as
> irreducibly external — requires live API keys + Ollama instance.**

> ### Multi-LLM Phase 6 — queue.ts main ingestion single-pass refactor — 2026-05-22 (HIGHEST RISK)
>
> Main ingestion `IngestionQueue.processBatch()` migrates from multi-turn
> agent loop (maxTurns:50 with all six tools) to single-pass via
> `runtimeAwareComplete`. Prompt-builder instructs JSON edits envelope;
> daemon parses, sanitizes paths (rejects out-of-tree AND inside-raw),
> writes via `atomicWrite`, passes `writtenPaths` to existing
> `reconcileWrittenPages`. Shared edits parser extracted to
> `src/llm/edits.ts` (consumed by heal-handlers + queue.ts). `maxTokens`
> capped at 8192 to stay under Anthropic SDK 10-min request threshold;
> streaming support deferred. `resumeSessionId` field removed (single-pass
> means each batch is independent). **580 tests** across **62 files** —
> 563 prior baseline + 17 new edits-shared-module tests. All 5 gates
> green. **Behavioral parity vs SDK baseline on 5+ fixtures is deferred
> as irreducibly external — requires live API run.**

> ### Multi-LLM Phase 5 — heal-handlers single-pass refactor — 2026-05-22
>
> `invokeHeal` migrates from multi-turn agent loop (maxTurns:10 with
> Read/Glob/Grep/Write/Edit tools) to single-pass via `runtimeAwareComplete`.
> Model now returns structured JSON `{ edits: [{ path, content }] }`;
> daemon parses, sanitizes paths (rejects out-of-tree), and writes files
> via `atomicWrite`. Six heal kinds (stale / duplicate / broken-link /
> contradiction / consolidation / missing-backlink) keep their existing
> handler-facing contracts. New helpers: `parseHealResponse` (defensive
> JSON extraction), `resolveHealEditPath` (path sanitization). 10 existing
> tests updated to mock at the new boundary (`runtimeAwareComplete`
> instead of `invokeIngestionAgent`); test count unchanged at 563. Real
> model JSON-edits behavior is deferred to Phase 6 fixture comparison.
> All 5 gates green.

> ### Multi-LLM Phase 4 — compounding/engine single-pass refactor — 2026-05-22
>
> `CompoundingEngine.synthesizeCluster()` migrates from multi-turn agent
> loop (maxTurns:20 with Read/Glob/Grep/Write) to single-pass via
> `runtimeAwareComplete`. Daemon pre-assembles full source bodies into
> the prompt (16KB cap per source with `_[truncated]_` marker), model
> returns markdown body only, daemon assembles frontmatter from cluster
> metadata and writes via WikiStore. First phase establishing the
> "model returns text, daemon writes files" pattern that Phases 5+6
> scale to edits and multi-file ingestion. Defensive
> `stripFrontmatterIfPresent` guards against model emitting frontmatter
> despite instructions. **563 tests** across **61 files** — 558 prior
> baseline + 5 new. All 5 gates green. Daemon-only phase.

> ### Multi-LLM Phase 3 — query-engine single-pass refactor — 2026-05-22
>
> `QueryEngine.answer()` migrates from multi-turn agent loop (maxTurns:5
> with Read/Glob/Grep tools) to single-pass completion via
> `runtimeAwareComplete`. Full page bodies are pre-assembled into the
> prompt (16KB cap per hit, with `[truncated]` marker); the model no
> longer needs to use Read mid-conversation. 4 new tests cover full-body
> inclusion, truncation cap, no-Agent-SDK structural check, and error
> propagation. **558 tests** across **60 files** — 554 prior baseline +
> 4 new. All 5 gates green. Daemon-only phase; no wotw-cloud changes
> beyond the pass doc.

> ### Multi-LLM Phase 2 — query-expansion + vocabulary-enricher migration — 2026-05-22
>
> Two lowest-risk auxiliary call sites migrated to the LLMProvider
> abstraction via a new daemon-side `runtimeAwareComplete` wrapper that
> dispatches API mode → `AnthropicProvider.completeWithUsage`, CLI mode →
> existing `invokeIngestionAgent` subprocess path. The wrapper is the
> right boundary because `LLMProvider.complete()` is API-mode-only by
> design (provider-agnostic); CLI mode is Anthropic-only by construction
> and stays on the subprocess path. 5 new wrapper tests + 6 existing
> caller tests updated to mock at the new boundary (no test deletion,
> behavior assertions preserved). **554 tests** across **59 files** —
> 549 prior baseline + 5 new. All 5 gates green.
> Daemon-only phase; no wotw-cloud changes beyond the pass doc.

> ### Multi-LLM Phase 1 — LLMProvider interface + AnthropicProvider — 2026-05-22
>
> Establishes the architectural target abstraction in parallel with the
> existing Agent SDK call surface. Canonical `LLMProvider` interface lives
> in `wotw-cloud/packages/shared/src/llm/types.ts`; daemon carries a
> byte-identical vendored copy at `src/llm/types-vendored.ts` enforced by
> CI script `check-llm-types-sync.mjs` (sibling to chain-hash sync).
> `AnthropicProvider` at `src/llm/providers/anthropic.ts` uses
> `@anthropic-ai/sdk` Messages API directly — **no Agent SDK dependency in
> new code paths**. 20 unit tests cover the interface contract, cost
> computation, finish reason normalization, content block filtering, and
> a structural check that the provider does not import the Agent SDK.
> **549 tests** across **58 files** — 529 baseline preserved + 20 new
> AnthropicProvider tests. All 5 gates green (typecheck, lint,
> format:check, test, build). No call site migration in this phase;
> Phases 2–6 migrate query-expansion / vocabulary-enricher / query-engine /
> compounding / heal-handlers / queue.ts (highest risk).



**Project:** `watcher-on-the-wall` (`wotw`) — a self-bootstrapping persistent
AI knowledge daemon.
**Repo path:** `/home/jgoodman/watcher-on-the-wall`
**Version shipped:** `0.2.0`
**License:** AGPL-3.0-or-later
**Author line in package.json:** 3030 Labs LLC
**Target runtime:** Node.js ≥ 20

> ### Deep Verification Audit Fix Pass — 2026-04-11
>
> All 36 findings from adversarial deep-verification audit resolved:
> 10 CRITICAL (search health pre-flight, stdin failure guard, CLI token
> estimation, ENOENT-only cost catch, provenance corruption detection,
> fsync propagation, watcher retry+DLQ, empty batch guard, token store
> backup, early fallback logger), 8 HIGH (heal handler search rebuild,
> provenance gap surfacing, watcher degraded flag, unhandled rejection
> shutdown, superseded-candidate detection, atomic vocabulary write,
> real provenance hashes, search rollback), 10 MEDIUM (dead-letter null,
> bare catch logging, config warning, expansion log level, parsePage
> coercion logging, PID atomic write, cost cache ordering, reconciliation
> timer, errMsg utility, lint mode warning), 8 LOW (serve stub update,
> slug collision avoidance, skip unreadable files, EACCES propagation,
> temp file cleanup, model pricing warning, dynamic heal model_id,
> get_index isError). New `errMsg()` utility replaced all 18 unsafe
> `(err as Error).message` casts across 16 files. Zero bare `catch {}`
> blocks remain.
> **446 tests** across **51 files**. **76 source files**, ~13,100 source LoC,
> ~300 KB CLI bundle. All 5 gates green.
>
> ### Test Suite Fix Pass — 2026-04-12
>
> Every CRITICAL and HIGH audit fix now has a regression test that fails
> if the fix is reverted. 53 tests added, 18 strengthened, 2 deleted,
> 2 rewritten. 7 new test files: `watcher-retry`, `ingestion-queue`,
> `provenance-gaps`, `daemon-unhandled-rejection`, `vocabulary-enricher`,
> `debounce`, `event-classifier`. Coverage gaps filled for sanitize rules
> (8 of 9 patterns), `loadConfig()`, `fileExists`/`dirExists` EACCES,
> `atomicWrite` temp cleanup, `DebounceBatcher`, `EventClassifier`,
> `healContradiction`. P4 cleanup removed 2 tests that tested Node.js
> internals, not production code. `typeof === "number"` assertions in
> tests reduced to zero. Tracker: `TEST-FIX-PASS.md`.

> ### Feature Pass 004: Retrieval Hardening — 2026-04-11
>
> Four retrieval-hardening features informed by "The Price of Meaning"
> (arXiv 2603.27116), closing the semantic coverage gap in BM25 search:
> (1) **Query Expansion** — LLM-powered keyword variant generation before
> BM25 search (`query.expand: true`); (2) **Richer YAML Metadata** — new
> `domain`, `scope`, `key_terms` frontmatter fields; `key_terms` indexed
> with 2x boost; `--domain`/`--scope` filtering on search + query;
> (3) **Knowledge Consolidation** — detect fragmented topic clusters via
> union-find at threshold 40, merge via `wotw lint --fix`, mark originals
> `status: consolidated`; (4) **Zero-Hit Monitoring + Vocabulary
> Enrichment** — JSONL query log, `computeZeroHitRate`, automated
> `key_terms` enrichment when zero-hit rate exceeds 20%.
> **386 tests** across **42 files**. **75 source files**, ~12,800 source LoC,
> ~289 KB CLI bundle. All gates green.

> ### Codex Audit Fix Pass — 2026-04-10
>
> 3 findings from external Codex audit fixed: (1) version string drift —
> all hardcoded `0.1.0` replaced with `VERSION` from `src/utils/version.ts`
> (reads `package.json` via `createRequire`); (2) `TokenStore.load()` crash
> on corrupt `tokens.json` — `JSON.parse` wrapped in try/catch with
> empty-store fallback; (3) `pnpm audit --prod` added to CI workflow.
> **359 tests** across **38 files**. **72 source files**, ~11,950 source LoC,
> ~273 KB CLI bundle. All gates green.

> ### v0.2 Reconciliation Pass — 2026-04-09
>
> Post-sprint reconciliation: 8 features verified/adapted, 4 with new
> code (trust_proxy, zero-hit guard, staging integration, stale rewrite).
> **356 tests** across **37 files**. **71 source files**, ~11,900 source LoC,
> ~273 KB CLI bundle. All gates green (typecheck, lint, format, tests, build).
>
> **Feature 7: X-Forwarded-For Proxy Trust (F-8 audit fix).** New
> `server.trust_proxy: false` default. `extractClientIp` in middleware
> only uses `X-Forwarded-For` when `trustProxy: true`, closing a
> rate-limit bypass on direct-connect deployments. 3 new tests.
>
> **Feature 8: Zero-Hit Grounding Guard.** `QueryEngine.answer()` now
> short-circuits with "No relevant wiki pages found" when the search
> index returns zero hits. No LLM call, $0 cost. 2 new tests.
>
> **Feature 3 Gap: Staging Integration.** `ingestion.staging: true`
> default; `reconcileWrittenPages` redirects pages to `candidates/`.
> `wotw start --auto-approve` flag. `buildIngestionPrompt` includes
> rejection feedback from `candidates/rejected/`. `wotw init` scaffolds
> `candidates/` and `candidates/rejected/`. 5 new staging tests + 3
> config validation tests.
>
> **Feature 4: Stale Rewrite.** `wotw stale` rewritten to wrap
> `computeHealthReport` from health.ts instead of parallel staleness
> system. `parseDuration`, `scoreThresholdForDuration` exported. 11
> stale tests (rewritten).
>
> **New test files (+2):** `test/unit/staging.test.ts` (5),
> `test/unit/query-engine.test.ts` (2).
> **Modified test files:** `test/unit/middleware.test.ts` (+3),
> `test/unit/config.test.ts` (+3), `test/unit/stale-command.test.ts`
> (rewritten, 11 tests).

> ### v0.2 Implementation Sprint — 2026-04-09
>
> **2 pre-sprint fixes + 6 features.** All 300 existing tests preserved,
> 37 new tests added (**337 total** across **35 files**). **71 source files**,
> ~11,665 source LoC, ~272 KB CLI bundle. All gates green (typecheck,
> lint, format, tests, build).
>
> **Fix A: Config Loader Validation.** Comprehensive Zod schema
> (`WotwConfigSchema`) validates every field on load with type/range
> checks. `validateConfig()` runs `safeParse` and throws clear errors
> with dotted field paths. 7 new tests in `test/unit/config.test.ts`.
>
> **Fix B: Token File Permissions.** `chmodSync(0o600)` after every
> atomic write in `TokenStore.save()`. 1 new test verifying mode.
>
> **Feature 1: Provenance Footers.** New `src/wiki/provenance-footer.ts`
> with sentinel-delimited `<!-- wotw:provenance:start/end -->` footer
> containing `[[wikilink]]` source references. `ensureProvenanceFooter`
> is idempotent (strip + re-append). Integrated into
> `reconcileWrittenPages`. 8 new tests.
>
> **Feature 2: Full-Text Search.** `wotw search <terms>` — offline
> MiniSearch-based FTS over wiki content (no daemon needed). Flags:
> `--top N`, `--json`, `--open`. 5 new tests.
>
> **Feature 3: Knowledge Lifecycle / Staleness.** New frontmatter fields:
> `last_compiled`, `source_count`, `last_confirmed`, `superseded_by`,
> `rejected_at`, `rejection_note`. `wotw stale` command with threshold
> parsing (`14d`, `2w`), `--json`, `--dashboard` (Dataview). 5 new tests.
>
> **Feature 4: Candidates Approve/Reject Workflow.** `WikiStore` gains
> `candidatesDir`, `rejectedDir`, `listCandidates()`, `listRejected()`.
> Three new CLI commands: `wotw approve [file] [--all]`,
> `wotw reject <file> [--reason]`, `wotw candidates [--json]`.
> Approved pages go to `wiki/<category>/`, rejected pages go to
> `candidates/rejected/` with frontmatter metadata. Provenance records
> appended on approve. 10 new tests.
>
> **Feature 5: Obsidian Launch.** Already implemented in FP002 `wotw init`
> wizard — graceful fallback when Obsidian is not installed.
>
> **Feature 6: Getting Started Page.** New template
> `src/wiki/templates/getting-started.md` scaffolded into `wiki/` during
> `wotw init`. Covers quick start, wiki structure, all CLI commands, tips.
> 1 new test.
>
> **New source files (+6):** `src/cli/commands/approve.ts`,
> `src/cli/commands/reject.ts`, `src/cli/commands/candidates.ts`,
> `src/cli/commands/stale.ts`, `src/cli/commands/search.ts`,
> `src/wiki/provenance-footer.ts`.
> **New template (+1):** `src/wiki/templates/getting-started.md`.
> **New test files (+4):** `test/unit/candidates-workflow.test.ts` (10),
> `test/unit/provenance-footer.test.ts` (8),
> `test/unit/stale-command.test.ts` (5),
> `test/unit/search-command.test.ts` (5).
> **Modified test files:** `test/unit/config.test.ts` (+7),
> `test/unit/token-store.test.ts` (+1),
> `test/unit/init-wizard.test.ts` (+1).

> ### Feature Pass 003 — 2026-04-09
>
> **Knowledge Health System.** Four interconnected features, written on
> top of the post-Feature-Pass-002 tree. Full pass report at
> `FEATURE-PASS-003.md`. Highlights:
>
> - **Knowledge quality scoring.** Every wiki page gets a health score
>   (0–100) based on five factors: staleness, source availability, link
>   health, duplicate risk, and contradiction risk. Scores use a weighted
>   average with configurable weights. New `src/wiki/health.ts` (~517 LoC)
>   and `src/wiki/heal-handlers.ts` (~450 LoC).
> - **Deduplication detection + auto-merge.** Pages with high search-index
>   similarity are grouped transitively via union-find. `wotw lint --fix`
>   merges duplicate groups via the LLM, marking surplus pages as
>   `status: merged` with `merged_into:` frontmatter.
> - **Auto-healing via `wotw lint --fix`.** New `--fix`, `--yes`, `--json`
>   flags on `wotw lint`. Five heal handlers dispatch by finding kind:
>   `healStale`, `healDuplicate`, `healBrokenLinks`, `healMissingBacklinks`
>   (no LLM), `healContradiction`. Budget-gated, provenance-tracked
>   (`type: "heal"` records), capped by `max_fixes_per_run`.
> - **Health surfacing.** `wotw status` shows a one-line health summary.
>   `get_stats` MCP tool returns `health.avg_score`, `pages_below_50`,
>   `lowest_scoring_page`. Daemon `LintScheduler` gains `auto_fix`
>   support.
>
> **New frontmatter fields:** `merged_into` (slug of survivor page),
> `contradictions` (array of contradicting slugs). New page statuses:
> `"merged"`, `"stale"`.
>
> **New config block:** `health:` with staleness thresholds/scores,
> weights, `duplicate_threshold`, `auto_fix_staleness_below`,
> `max_fixes_per_run`, `detect_contradictions`. Plus `lint.auto_fix`.
>
> **New documentation:** `docs/knowledge-health.md`.
> Updated: `docs/configuration.md`, `docs/cli-reference.md`,
> `docs/provenance.md`, `docs/mcp-tools.md`.
>
> **Test delta:** 272 → **300** (+28 across +5 files —
> `test/unit/health-scoring.test.ts` (15),
> `test/unit/dedup-detection.test.ts` (4),
> `test/unit/heal-handlers.test.ts` (5),
> `test/integration/health-report.test.ts` (2),
> `test/integration/lint-fix.test.ts` (2)). **Source files:** 63 → 65
> (+2: `src/wiki/health.ts`, `src/wiki/heal-handlers.ts`).
> **CLI bundle:** ~215 KB → ~246 KB. All 5 gates green.

> ### Feature Pass 002 — 2026-04-09
>
> **Obsidian-aware interactive `wotw init` wizard.** One product-surface
> feature, written on top of the post-Audit-V2-HIGH tree. Full pass
> report at `FEATURE-PASS-002.md`. Highlights:
>
> - **Interactive setup wizard.** `src/cli/commands/init.ts` rewritten
>   (~780 LoC, was ~160) as a 7-step `@clack/prompts` flow: intro →
>   idempotency check → vault location (auto-detects Obsidian vaults
>   from `obsidian.json`, plus "create new" and "custom path") →
>   overlay detection (existing `.obsidian/` → inline vs subdir) →
>   silent runtime detection (Claude CLI vs `ANTHROPIC_API_KEY`) →
>   scaffold with spinner → optional launch via `obsidian://open` URI →
>   next-steps panel.
> - **Non-interactive mode.** No TTY, `--yes`, or `nonInteractive: true`
>   skips every prompt, uses `--path`/positional/`cwd`, and never
>   launches Obsidian. This is the mode CI systems and scripts use.
> - **Obsidian vault detection.** New `src/cli/lib/vault-detect.ts`
>   (~190 LoC) — reads the platform-specific `obsidian.json` registry
>   (macOS / Windows / Linux / WSL paths), walks up for `.obsidian/`,
>   dispatches `obsidian://open?path=<enc>` via `open` / `xdg-open` /
>   `cmd /c start`. Never throws — a missing registry file, bad JSON,
>   or a failed launcher all degrade to the manual path.
> - **Fresh vs overlay.** Fresh vaults get minimal `.obsidian/{app,
>   appearance,graph}.json` defaults (purple `#7c3aed` accent, `raw/`
>   attachments, graph color groups). Overlay into existing vaults
>   never touches `.obsidian/`. `.gitignore` is append-or-create — if
>   an existing `.gitignore` mentions `.wotw/` the wizard leaves it
>   alone; otherwise it appends a `# wotw daemon state` block.
> - **Idempotent re-runs.** Config file + `raw/` + `wiki/` + all 6
>   category dirs → short-circuit with a "nothing to do" note. `--force`
>   overwrites templates but still never touches the user's
>   `.obsidian/`.
> - **Starter `wiki/index.md`.** Now carries a `__WOTW_UPDATED_ISO__`
>   frontmatter placeholder replaced at init time, a categories list
>   with `[[wikilinks]]`, and the `<!-- wotw:index:start -->` /
>   `<!-- wotw:index:end -->` sentinel block that
>   `src/wiki/index-manager.ts` maintains.
>
> **New documentation:** `docs/obsidian-setup.md` (122 LoC — registry
> locations, overlay semantics, launcher dispatch, troubleshooting).
> `docs/cli-reference.md::wotw init` section fully rewritten.
> `README.md` Quickstart updated to show the interactive wizard and
> link to the Obsidian guide.
>
> **New dependency:** `@clack/prompts@^1.2.0` (pure runtime, ~15 KB
> added to the CLI bundle).
>
> **Test delta:** 252 → **272** (+20 across +2 files —
> `test/unit/vault-detect.test.ts` (10) and
> `test/unit/init-wizard.test.ts` (10)). **Source files:** 62 → 63
> (+1 `src/cli/lib/vault-detect.ts`). **CLI bundle:** ~200 KB →
> ~215 KB. All 5 gates green.

> ### Audit V2 fixes — 2026-04-09
>
> A second independent audit pass (`AUDIT-REPORT-V2.md`) ran after
> Feature Pass 001 landed. **All 3 HIGH findings have been resolved.**
> The full mapping is in `AUDIT-V2-FIXES.md`. Headline deltas:
>
> - **F-7** — `src/server/middleware.ts`: legacy single-token auth now
>   uses a constant-time `safeEqual` helper backed by
>   `crypto.timingSafeEqual` instead of `!==`, so a network-level timing
>   oracle cannot enumerate operator-chosen tokens that may be short or
>   low-entropy. New regression test in `test/unit/middleware.test.ts`
>   asserts the accept/reject contract is preserved across exact match,
>   same-length-wrong-bytes, shorter prefix, longer extension, empty
>   bearer, and missing-header cases.
> - **F-12** — `SECURITY.md`: removed the false claim that multi-user
>   tokens are SHA-256 hashed and that plaintext is never persisted.
>   The "Cryptographic details" section now correctly describes the
>   verbatim `tokens.json` storage (mode `0600`) and the operational
>   implications of a leaked file. Also corrected the
>   "Race conditions in durable writes" bullet, which previously claimed
>   the cost log, provenance chain, and dead-letter queue used
>   temp-file + rename — they actually use append-only `appendFile`
>   under a single-writer mutex.
> - **F-13** — this file. The §1, §3, §4, §5, §6, §9, §10, §12, and
>   §15 sections have all been resynchronized with the post-Feature-
>   Pass-001 working tree. Headline numbers: **62 source files /
>   ~8,820 LoC**, **24 test files / ~4,030 LoC**, **252 tests passing**.
>   The deleted `src/utils/hash.ts` is no longer in the inventory; the
>   four Feature Pass 001 source files (`daemon/lint-scheduler.ts`,
>   `ingestion/dead-letter.ts`, `cli/commands/logs.ts`, plus deletion
>   handling in `ingestion/queue.ts` / `watcher/index.ts` /
>   `wiki/page.ts`) are listed where they belong, and the four new test
>   files (`lint-scheduler`, `dead-letter`, `logs-command`,
>   `deletion-handling`) are in §5.
>
> All five quality gates remain green after the V2 fixes:
> `pnpm typecheck` clean, `pnpm lint` clean (0/0), `pnpm format:check`
> clean, **252/252 tests passing across 24 test files**,
> `pnpm build` produces ESM + DTS outputs.

> ### Feature Pass 001 — 2026-04-09
>
> Four product-surface features and three pre-release docs landed under
> the same quality bar as the original five phases. Full pass report at
> `FEATURE-PASS-001.md`. Highlights:
>
> - **Periodic background lint** — `LintScheduler` DaemonSubsystem in
>   `src/daemon/lint-scheduler.ts`. Runs the same structural sweep as
>   `wotw lint` on a configurable interval (default off). Cheap no-op
>   when disabled. `setInterval(...).unref()` so it never holds the
>   daemon open.
> - **Deletion handling (archive)** — new `"archive"` provenance
>   operation type. Watcher emits `deletedPaths` on the batch
>   (`src/watcher/index.ts`); queue walks the chain to find every wiki
>   page whose `source_files` included the deleted raw path
>   (`src/ingestion/queue.ts::archiveDeletedSources`), rewrites
>   frontmatter to `status: orphaned` + `orphaned_at` + `orphaned_source`
>   (`src/wiki/page.ts`), and appends an archive record with
>   `source_hashes: ["deleted"]` + `model_id: "none"`. **Wiki files are
>   never deleted.** Orphan count surfaces in `wotw lint`, `wotw status`,
>   and the `get_stats` MCP tool.
> - **Observability — `wotw logs` + startup banner** — new
>   `src/cli/commands/logs.ts` tails `daemon.log_file` with default
>   "last 20 lines" mode and a `-f`/`--follow` streaming mode that uses
>   `watchFile` (250 ms poll) for WSL-friendliness and handles log
>   rotation via size-shrink detection. The daemon now logs a single
>   INFO banner at startup with runtime mode, MCP URL, wiki root, DLQ
>   status, and lint schedule status.
> - **Dead-letter queue** — `DeadLetterQueue` JSONL ledger in
>   `src/ingestion/dead-letter.ts`. Empty-string config path disables
>   the queue (every call is a no-op). Wired into `IngestionQueue`
>   catch blocks; failed-batch count surfaces in `wotw status` and
>   `get_stats`. Survives malformed lines in `list()`. Idempotent
>   `clear()`.
>
> Pre-release docs added at the repo root: `CONTRIBUTING.md` (165 LoC),
> `SECURITY.md` (111 LoC), `ROADMAP.md` (123 LoC). Existing
> `docs/configuration.md`, `docs/cli-reference.md`, `docs/architecture.md`,
> `docs/provenance.md`, and `docs/mcp-tools.md` were updated for the
> new surfaces.
>
> Test count delta from this pass: **231 → 251** (+20 across +4 files).

> ### Audit findings resolved — 2026-04-08
>
> Every finding from the first independent audit report
> (`AUDIT-REPORT.md`) has been fixed: **16/16** — 5 HIGH, 3 MEDIUM, 8
> LOW. A one-page summary with the finding-to-commit mapping lives in
> `AUDIT-FIXES.md`. Headline deltas:
>
> - **Tests: 219 → 231** (added 7 sanitize regex tests + 5 MCP server
>   path-canonicalization / no-auth safety-rail tests).
> - **Test files: 19 → 20** (new `test/unit/sanitize.test.ts`).
> - All five HIGH findings were documentation drift — fixed in
>   `docs/architecture.md`, `docs/cli-reference.md`, `docs/mcp-tools.md`,
>   and `docs/provenance.md`.
> - M-SEC-1: `resolveWikiPath` now uses canonical `path.resolve` +
>   `path.relative` instead of a substring `..` check, closing the
>   Windows-drive-letter bypass.
> - M-SEC-2: MCP server now emits a loud WARN banner when started with
>   no auth, and refuses to start at all when no-auth is combined with a
>   non-loopback host.
> - M-PIPE-1: Ingestion pipeline now hashes source files and wiki
>   outputs eagerly, inline with the relevant steps, instead of lazily
>   at end-of-batch.
> - L-DUP-1: `src/utils/hash.ts` was deleted; all callers now use the
>   consolidated `src/provenance/hash.ts` (with backwards-compatible
>   aliases `sha256`, `sha256Json`, `stableStringify`).
> - L-PERF-1 / L-CODE-3: `CostTracker.spentToday()` is now cached and
>   backed by a shared `sumCostsForDay` helper reused from the CLI
>   `wotw status` command.

This document is an auditable summary of everything that was built across
all five phases plus the Phase 6 dual-mode runtime addendum. Every claim
in this document maps to a concrete artifact in the repository. File
counts, line counts, test counts, and gate results were captured directly
from the working tree at build-complete time.

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Build history — five phases, one addendum, six gates](#2-build-history--five-phases-one-addendum-six-gates)
3. [Repository layout](#3-repository-layout)
4. [Source inventory (every file)](#4-source-inventory-every-file)
5. [Test inventory (every file + count)](#5-test-inventory-every-file--count)
6. [Documentation inventory](#6-documentation-inventory)
7. [Feature-by-feature delivery](#7-feature-by-feature-delivery)
8. [Design decisions](#8-design-decisions)
9. [Quality gates — final verification](#9-quality-gates--final-verification)
10. [CLI surface](#10-cli-surface)
11. [MCP tool surface](#11-mcp-tool-surface)
12. [Configuration surface](#12-configuration-surface)
13. [Provenance format](#13-provenance-format)
14. [Dependencies](#14-dependencies)
15. [Known gaps and deferred items](#15-known-gaps-and-deferred-items)

---

## 1. Executive summary

`watcher-on-the-wall` is a background daemon that:

- **Watches** a raw-notes directory and batches changes with exponential
  backoff.
- **Ingests** each batch with a Claude agent — hosted by either the
  local `claude` CLI binary (free, subscription-covered) or the
  `@anthropic-ai/claude-agent-sdk` (pay-per-token) — that writes
  YAML-frontmatter markdown pages into a category-sharded wiki.
- **Auto-detects** which runtime to use at startup (`auto`), or runs a
  forced `cli` / `api` mode if the operator pins one explicitly.
- **Serves** the wiki to MCP clients (Claude Desktop, Claude Code) over
  stateless streamable-HTTP with per-IP rate limiting and bearer-token
  auth.
- **Provenance-signs** every state mutation via an append-only SHA-256
  hash chain whose records are content-addressable and tamper-evident.
- **Compounds** its knowledge by periodically synthesizing higher-level
  pages across tag clusters.
- **Authenticates** multiple users via a per-user bearer-token store
  with atomic persistence and admin-friendly CLI.
- **Tracks costs** against per-operation and daily-dollar budgets and
  refuses LLM calls that would exceed them. CLI mode logs `cost=0` for
  every operation (subscription-covered); API mode reads
  `total_cost_usd` from the SDK.
- **Commits** every batch to a git repo in the wiki root for auditability.

### Headline numbers

| Metric | Value |
|---|---|
| Source TypeScript files | **72** (post Codex audit fix) |
| Total source LoC | **~11,950** |
| Test files | **38** |
| Total test LoC | **~6,200** |
| **Tests passing** | **359 / 359** (100%, post Codex audit fix) |
| Doc files under `docs/` | **9** (includes new `knowledge-health.md`) |
| Top-level doc files | **6** (README.md, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md, ROADMAP.md, this file) |
| Total doc LoC | **~2,400** |
| Build target | Node 20, ESM |
| CLI binary size | ~273 KB (`dist/cli/index.js`) |
| Daemon entry size | ~179 KB (`dist/daemon/entry.js`) |
| Lint errors | **0** |
| Typecheck errors | **0** |
| Prettier diffs | **0** |
| Runtime modes | **`cli` / `api` / `auto`** (auto-detected at startup) |

### Status of each hard gate

| Gate | Phase | Status | Evidence |
|---|---|---|---|
| Gate 1 | Foundation | PASS | `wotw init` + `wotw start` / `stop` / `status` smoke tests green; daemon PID/lock lifecycle correct |
| Gate 2 | Core pipeline | PASS | Live LLM ingestion run produced valid wiki pages at `/tmp/wotw-gate2/wiki-store/`; bidirectional links repaired; git committed |
| Gate 3 | MCP serving | PASS | Live MCP client call over HTTP returned correct search/query results against Gate 2 wiki |
| Gate 4 | Provenance + compounding | PASS | Live compounding run wrote `wiki/syntheses/cryptography.md`; provenance chain verified end-to-end; `wotw audit --full` clean |
| Gate 5 | Tests + docs + CI | PASS | 192/192 tests passing; lint/typecheck/format clean; CI workflow written; docs written; multi-user auth shipped |
| Gate 6 | Dual-mode runtime | PASS | 219/219 tests passing; auto-detection resolves cli/api/error correctly; CLI invoker spawn + snapshot diff verified by 7 unit tests; daemon WSL spawn semantics verified by 8 integration tests; docs updated; lint/typecheck/format clean |
| Gate 7 | Audit fixes | PASS | 16/16 audit findings resolved (5 HIGH doc drift, 3 MEDIUM security/pipeline, 8 LOW); 231/231 tests passing across 20 files; lint/typecheck/format/build all clean. See `AUDIT-FIXES.md`. |
| Gate 8 | Feature Pass 001 | PASS | 4 features shipped (lint scheduler, deletion→archive, `wotw logs`, dead-letter queue) with +20 tests across +4 files. 251/251 tests passing across 24 files; lint/typecheck/format/build all clean. See `FEATURE-PASS-001.md`. |
| Gate 9 | Audit V2 fixes | PASS | 3 HIGH findings resolved (F-7 timing-safe legacy auth, F-12 SECURITY.md token-storage claim, F-13 BUILD-SUMMARY.md drift). **252/252** tests passing across **24** files; lint/typecheck/format/build all clean. See `AUDIT-V2-FIXES.md`. |
| Gate 10 | Feature Pass 002 | PASS | Obsidian-aware interactive `wotw init` wizard. New `src/cli/lib/vault-detect.ts`, rewritten `src/cli/commands/init.ts`, new `@clack/prompts@^1.2.0` dependency, new `docs/obsidian-setup.md`. **272/272** tests passing across **26** files; lint/typecheck/format/build all clean. See `FEATURE-PASS-002.md`. |
| Gate 11 | Feature Pass 003 | PASS | Knowledge Health System: health scoring, deduplication, auto-healing (`wotw lint --fix`), contradiction detection. New `src/wiki/health.ts`, `src/wiki/heal-handlers.ts`, `health:` config block, `type: "heal"` provenance, new `docs/knowledge-health.md`. **300/300** tests passing across **31** files; lint/typecheck/format/build all clean. See `FEATURE-PASS-003.md`. |
| Gate 12 | v0.2 Reconciliation | PASS | 8 features reconciled (trust_proxy, zero-hit guard, staging integration, stale rewrite, plus 4 verified-in-place). **356/356** tests passing across **37** files; lint/typecheck/format/build all clean. See `RECONCILIATION-PASS.md`. |
| Gate 13 | Codex Audit Fix | PASS | 3 findings fixed (version drift → `src/utils/version.ts` via `createRequire`, TokenStore corrupt-JSON guard, `pnpm audit --prod` in CI). **359/359** tests passing across **38** files; lint/typecheck/format/build all clean. |

---

## 2. Build history — five phases, one addendum, six gates

The project was built to a hard five-phase plan with an acceptance gate
between phases. Earlier phases were not permitted to leave bugs into
later phases; every gate had to be demonstrably green (including live
LLM runs for gates 2 and 4) before the next phase started. After Gate 5
shipped, a dual-mode runtime addendum (Phase 6) was bolted on under
the same quality bar — see [Phase 6](#phase-6--dual-mode-runtime-addendum) below.

### Phase 1 — Foundation

**Deliverables:**
- `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- ESLint + Prettier setup
- `src/cli/index.ts` Commander.js entrypoint
- `src/daemon/{index,entry,lifecycle,process-manager,config}.ts`
- Detached daemon child process model (CLI forks itself with
  `WOTW_DAEMON_CHILD=1`)
- PID file + lock file + log file
- Graceful `SIGTERM` shutdown
- `wotw init` / `start` / `stop` / `status` commands
- Config loader via cosmiconfig (YAML, JSON, rc files, package.json key)
- Path resolution helpers (`~` expansion, base-dir resolution)

**Gate 1:** Fresh directory → `wotw init` → `wotw start` → `wotw status`
shows running daemon → `wotw stop` → PID file cleaned up. Verified.

### Phase 2 — Core pipeline (watcher + ingestion + wiki)

**Deliverables:**
- `src/watcher/{index,debounce,event-classifier,ignore-patterns}.ts`
  — chokidar-backed file watcher with exponential-backoff debouncing
- `src/ingestion/{queue,llm-invoker,prompt-builder,wiki-writer,git-committer,cost-tracker,model-router}.ts`
  — batch queue, Claude agent runner, path reconciliation, budget
  enforcement
- `src/wiki/{store,page,search,index-manager,cross-reference}.ts`
  — category-sharded markdown store, YAML frontmatter parser,
  minisearch index, bidirectional link repair
- `src/utils/{fs,git,hash,logger,retry,sanitize,types}.ts` — supporting
  infrastructure (atomic writes, simple-git wrapper, SHA-256, pino
  logger, retry-with-backoff)
- Wiki templates at `src/wiki/templates/{CLAUDE.md,index.md,log.md}`
- `wotw init` scaffolds a full wiki-store with templates + git repo

**Gate 2:** Live run against Anthropic API, ingested multiple raw notes,
produced valid wiki pages with correct frontmatter, bidirectional
`related:` links, git commits, and cost tracking. Verified at
`/tmp/wotw-gate2/wiki-store/`.

### Phase 3 — MCP serving

**Deliverables:**
- `src/server/{index,middleware,tools,resources,query-engine}.ts`
- HTTP server (`node:http`) with `/healthz` and `/mcp` endpoints
- `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk` —
  stateless mode, fresh `McpServer` per request (SDK invariant)
- Per-IP token-bucket rate limiter
- Bearer-token authentication (single-token mode)
- MCP tools: `search`, `list_pages`, `read_page`, `query`, `get_index`,
  `get_stats`, `related_pages`
- `QueryEngine` — natural-language question answering grounded in
  retrieved wiki pages with inline citations
- `src/cli/commands/{query,serve}.ts` + `src/cli/commands/lib/mcp-client.ts`

**Gate 3:** `wotw query "..."` → CLI → MCP client → HTTP → daemon →
QueryEngine → Claude → answer with citations. Verified end-to-end.

### Phase 4 — Provenance + compounding

**Deliverables:**
- `src/provenance/{chain,hash,index}.ts`
- SHA-256 hash chain with canonical-JSON content-addressable record ids
- Tamper-evident `chain_hash = sha256(previous_chain_hash || id)` field
- Single-writer promise-chain mutex for ordered appends
- `wotw audit` command (full walk + last-N walk, JSON output)
- Ingestion pipeline integration — every batch appends a provenance record
- `src/compounding/{engine,index}.ts` + `src/compounding/scheduler.ts`
- Tag-cluster detection + existing-synthesis deduplication
- Compounding budget gating
- MCP tools: `get_provenance_log`, `verify_provenance`, `synthesize`
- `wotw synthesize` CLI command

**Gate 4:** Live run triggered compounding, Claude wrote
`wiki/syntheses/cryptography.md`, provenance chain appended a
`type: "synthesize"` record, `wotw audit --full` walked the full chain
and verified every record's id and chain hash. Verified.

### Phase 5 — Multi-user + Tests + Docs + CI

**Deliverables (this phase):**
- `src/multi-user/{token-store,index}.ts` — per-user bearer tokens
- `src/cli/commands/user.ts` — `wotw user add|list|revoke`
- Middleware integration: `runMiddleware` now returns
  `{ ok, principal }`; `TokenStore` option added
- `McpHttpServer` constructs + loads `TokenStore` when
  `multi_user.enabled: true`
- **12 unit test files** + **4 integration test files** (16 total)
- **192 tests** covering every subsystem
- **6 docs** under `docs/` + `README.md`, `CHANGELOG.md`, this
  `BUILD-SUMMARY.md`
- ESLint v9 flat config migration (`eslint.config.js`,
  `tsconfig.eslint.json`)
- Real lint bugs fixed (see [§9](#9-quality-gates--final-verification))
- `.github/workflows/ci.yml` — matrix CI (Node 20 + 22) with
  typecheck, lint, format-check, build, test, and CLI smoke test

**Gate 5:** Everything below under [§9](#9-quality-gates--final-verification)
is green.

### Phase 6 — Dual-mode runtime addendum

After Gate 5 shipped, the daemon was extended to host every Claude
agent loop via either the local `claude` CLI binary (free, covered by
the user's Claude Pro/Max subscription) **or** the
`@anthropic-ai/claude-agent-sdk` (pay-per-token). The choice is made
once at daemon startup and applied uniformly to ingestion, query, and
compounding.

**Deliverables (this phase):**

- `src/ingestion/execution-mode.ts` — auto-detection logic.
  `findOnPath` runs `which`/`where`, `findApiKey` reads
  `process.env[execution.api_key_env]`, `resolveExecutionMode`
  produces a `{ mode: "cli" | "api", cliPath?, cliModel?, apiKeyEnv? }`
  result or throws `ExecutionModeError` with one of three codes:
  `CLI_BINARY_NOT_FOUND`, `API_KEY_NOT_SET`, `NO_RUNTIME_AVAILABLE`.
- `src/ingestion/cli-invoker.ts` — `invokeClaudeCli` spawns
  `claude --print --dangerously-skip-permissions --model <m>
  --append-system-prompt <s> [--max-turns N]` as a subprocess. The
  user prompt is piped on stdin (avoids `ARG_MAX`); written files are
  detected by snapshotting the wiki tree (path → size + mtime) before
  and after the run and diffing the result. Honors an optional
  `AbortController` and a timeout safety net via `setTimeout().unref()`.
  Snapshot ignores `.git`, `node_modules`, and the immutable `raw/`
  directory.
- `src/ingestion/llm-invoker.ts` — extended with a runtime-mode
  dispatch. The new `runtimeMode` and `cliConfig` fields on
  `InvokeOptions` route every call to either the SDK path (existing
  behavior) or the CLI invoker. A new `allowedTools` field lets
  callers narrow the tool whitelist (e.g. query passes `Read/Glob/Grep`
  only); the default remains `INGESTION_TOOLS`.
- `src/server/query-engine.ts`, `src/compounding/engine.ts` —
  refactored from direct `query()` calls to use `invokeIngestionAgent`
  with custom `allowedTools`. Both engines branch on `runtimeMode` for
  model selection (`execution.cli_model` in CLI mode, `modelRouter`
  pick in API mode) and skip the budget pre-flight in CLI mode (every
  spawn logs `cost=0`).
- `src/daemon/index.ts`, `src/daemon/entry.ts` — daemon resolves the
  execution mode at startup, exposes it via `getExecutionMode()`, and
  threads the resolved `runtimeMode` into `IngestionQueue`,
  `FileWatcher`, `McpHttpServer`, and `CompoundingEngine`. The
  resolved mode is logged at INFO with a one-line description.
- `src/watcher/index.ts` — watcher debounce timings are multiplied by
  a `CLI_DEBOUNCE_MULTIPLIER = 1.5` in CLI mode, coalescing more
  files per spawn to amortize subprocess startup cost without making
  interactive editing feel laggy.
- `src/daemon/config.ts` — new `execution:` config block
  (`mode: auto|cli|api`, `cli_path`, `cli_model`, `api_key_env`)
  with defaults. The pre-existing `models:` block is now documented
  as **API MODE ONLY**; in CLI mode every operation uses
  `execution.cli_model`.
- `test/unit/execution-mode.test.ts` — 12 tests covering all 7
  resolution paths (auto-cli, auto-api, auto-fail, cli-success,
  cli-fail, api-success, api-fail) plus `findOnPath` and `findApiKey`
  edge cases.
- `test/unit/cli-invoker.test.ts` — 7 tests using fake shell scripts
  as stand-in `claude` binaries: happy-path file detection,
  non-zero-exit failure surfacing, timeout-driven termination, snapshot
  diff hygiene (ignores `.git`/`node_modules`/`raw/`), 256KB stdin
  prompt round-trip, and abort-controller cancellation. All
  Win32-skipped via `it.skipIf(platform() === "win32")`.
- `test/integration/daemon-wsl-verification.test.ts` — 8 tests
  documenting and verifying the spawn-with-`detached: true` daemon
  pattern on WSL filesystems: PID file lifecycle, stale PID detection
  via signal 0, `proper-lockfile` mutual exclusion, lock re-acquisition
  after release.
- `docs/execution-modes.md` — new 120-line doc covering the runtime
  comparison table, auto-detection sequence, behavioral differences
  between modes, recommended setups, and troubleshooting for each of
  the three error codes.
- `docs/configuration.md`, `README.md` — updated to document the new
  `execution:` block and the dual-mode runtime feature.

**Gate 6:** All 219 tests pass; auto-detection resolves CLI/API/error
correctly under each combination of binary-on-PATH and env-var
presence; CLI invoker happy-path / failure / timeout / abort all
verified; daemon WSL spawn semantics verified; lint/typecheck/format
clean; build succeeds; docs updated. Verified.

---

## 3. Repository layout

```
watcher-on-the-wall/
├── .github/
│   ├── ISSUE_TEMPLATE/
│   └── workflows/
│       └── ci.yml              # CI matrix (Node 20/22)
├── dist/                       # tsup build output (cli, daemon, index)
├── docs/
│   ├── architecture.md
│   ├── cli-reference.md
│   ├── configuration.md
│   ├── execution-modes.md      # CLI vs API runtime modes (Phase 6)
│   ├── knowledge-health.md    # Knowledge health system (Feature Pass 003)
│   ├── mcp-tools.md
│   ├── multi-user.md
│   ├── obsidian-setup.md      # Obsidian integration guide (Feature Pass 002)
│   └── provenance.md
├── scripts/
├── src/
│   ├── cli/                    # Commander.js CLI (16 files, incl. logs)
│   ├── compounding/            # Compounding engine (2 files)
│   ├── daemon/                 # Daemon lifecycle (6 files, incl. lint-scheduler)
│   ├── ingestion/              # Ingestion pipeline (11 files, incl. cli-invoker, execution-mode, dead-letter)
│   ├── multi-user/             # Per-user token store (2 files)
│   ├── provenance/             # Hash-chain provenance (3 files)
│   ├── server/                 # MCP HTTP server (5 files)
│   ├── utils/                  # Shared utilities (6 files; utils/hash.ts deleted in L-DUP-1)
│   ├── watcher/                # File watcher + debounce (4 files)
│   ├── wiki/                   # Wiki store/search/index/health (8 files + templates)
│   └── index.ts                # Library re-export barrel
├── templates/                  # (empty placeholder for end-user templates)
├── test/
│   ├── fixtures/
│   ├── integration/            # 8 files, 42 tests
│   └── unit/                   # 23 files, 258 tests
├── .eslintrc.cjs               # Legacy — kept as historical reference
├── AUDIT-FIXES.md              # Audit V1 fix summary (16/16)
├── AUDIT-REPORT.md             # Audit V1 input
├── AUDIT-REPORT-V2.md          # Audit V2 input
├── AUDIT-V2-FIXES.md           # Audit V2 fix summary (3/3 HIGH)
├── BUILD-SUMMARY.md            # This document
├── CHANGELOG.md
├── CONTRIBUTING.md             # Pre-release contributor guide
├── FEATURE-PASS-001.md         # Feature Pass 001 report
├── FEATURE-PASS-002.md         # Feature Pass 002 report
├── FEATURE-PASS-003.md         # Feature Pass 003 report (Knowledge Health System)
├── LICENSE                     # AGPL-3.0-or-later
├── README.md
├── ROADMAP.md                  # Shipped / In flight / Planned / Won't build
├── SECURITY.md                 # Security policy + reporting + hardening checklist
├── eslint.config.js            # ESLint v9 flat config (current)
├── package.json
├── pnpm-lock.yaml
├── tsconfig.eslint.json        # Extended config that includes tests
├── tsconfig.json               # Strict TS compile config
├── tsup.config.ts              # ESM build with .d.ts output
└── vitest.config.ts            # node env, 30s timeouts
```

---

## 4. Source inventory (every file)

Every TypeScript file currently in `src/`, grouped by subsystem.
**Total: 65 files, ~10,831 LoC.**

### `src/cli/` — 17 files

| File | Purpose |
|---|---|
| `cli/index.ts` | Commander.js entrypoint. Dispatches to all registered commands. Handles `WOTW_DAEMON_CHILD=1` fork-exec. |
| `cli/output.ts` | Shared chalk/boxen/ora helpers: `line`, `info`, `success`, `warn`, `fail`, `keyValueTable`. |
| `cli/lib/vault-detect.ts` | **[Feature Pass 002]** Obsidian vault detection + launch helpers. `findObsidianVaults()` reads the platform-specific `obsidian.json` registry (macOS: `~/Library/Application Support/obsidian/`; Windows: `%APPDATA%/obsidian/`; Linux/WSL: `${XDG_CONFIG_HOME:-~/.config}/obsidian/`), parses it best-effort, filters to still-existing directories, sorts by `ts` desc. `findEnclosingVault(dir)` walks up looking for `.obsidian/` (bounded to 64 iterations). `openInObsidian(vaultPath)` dispatches an `obsidian://open?path=<enc>` URI via `open` / `xdg-open` / `cmd /c start`, times out after 5 s, never throws. All internals use platform-safe shell quoting. |
| `cli/commands/init.ts` | **[Feature Pass 002]** `wotw init [dir]` — Obsidian-aware interactive wizard. 7 steps (intro → idempotency → vault location → overlay detection → runtime detection → scaffold → launch → next steps). Uses `@clack/prompts` for the interactive UI. Silent runtime detection via `findOnPath` + `findApiKey` from `ingestion/execution-mode.ts`. Non-interactive mode (no TTY, `--yes`, or `nonInteractive: true`) skips every prompt. Fresh vaults get `.obsidian/{app,appearance,graph}.json` defaults; overlay never touches existing `.obsidian/`. `.gitignore` is append-or-create. Idempotent re-runs short-circuit. Exports `runInit(opts): Promise<RunInitResult>` for tests and programmatic use. |
| `cli/commands/start.ts` | `wotw start` — forks detached daemon child or runs foreground. |
| `cli/commands/stop.ts` | `wotw stop` — SIGTERM the daemon via PID file. |
| `cli/commands/status.ts` | `wotw status [--watch] [--json]` — snapshot TUI. **[Feature Pass 001]** Surfaces orphan count and dead-letter failed-batch count. **[Feature Pass 003]** Shows one-line health summary (avg score + pages needing attention). |
| `cli/commands/query.ts` | `wotw query <question>` — MCP client → query tool → formatted answer. |
| `cli/commands/audit.ts` | `wotw audit` — walk provenance chain, print records, verify. |
| `cli/commands/lint.ts` | `wotw lint [--fix] [--yes] [--json]` — run health checks over wiki. **[Feature Pass 003]** Rewritten: computes full health report (per-page scores + findings), dispatches auto-fixable findings to heal handlers when `--fix` is set. `--json` outputs machine-readable JSON. `--yes` skips confirmation. |
| `cli/commands/logs.ts` | **[Feature Pass 001]** `wotw logs [-n N] [-f]` — tail `daemon.log_file`. Default 20 lines, follow mode via `watchFile` (250 ms poll, WSL-friendly), handles log rotation via size-shrink detection, exits 0 with friendly message if log file is missing. |
| `cli/commands/install-hook.ts` | `wotw install-hook` — install Claude Code SessionStart hook. |
| `cli/commands/uninstall-hook.ts` | `wotw uninstall-hook` — remove Claude Code hook. |
| `cli/commands/serve.ts` | `wotw serve` — standalone MCP server (no watcher). |
| `cli/commands/synthesize.ts` | `wotw synthesize` — trigger compounding pass. |
| `cli/commands/user.ts` | `wotw user add|list|revoke` — multi-user token admin. |
| `cli/commands/lib/mcp-client.ts` | SDK-based MCP client shared by CLI commands. Per-request timeout option. |

### `src/daemon/` — 6 files

| File | Purpose |
|---|---|
| `daemon/index.ts` | `DaemonSubsystem` interface + root daemon orchestrator. **[Phase 6]** Resolves the execution mode at startup via `resolveExecutionMode`, exposes it via `getExecutionMode()`, logs the resolved mode prominently. |
| `daemon/entry.ts` | Child-process entrypoint. Constructs all subsystems and starts them. **[Phase 6]** Threads the resolved `runtimeMode` into `IngestionQueue`, `FileWatcher`, `McpHttpServer`, and `CompoundingEngine`. **[Feature Pass 001]** Constructs `LintScheduler` and `DeadLetterQueue`, and emits a single INFO startup banner with mode / MCP URL / wiki root / DLQ status / lint schedule status. |
| `daemon/lifecycle.ts` | Start/stop sequencing, signal handlers, graceful shutdown. |
| `daemon/lint-scheduler.ts` | **[Feature Pass 001]** `LintScheduler` DaemonSubsystem. Runs the structural sweep from `wotw lint` on a configurable interval (`lint.schedule_enabled`/`lint.interval_hours`, default off). Cheap no-op when disabled. `setInterval(...).unref()` so it never holds the daemon open. Clean sweeps log INFO; sweeps with issues log WARN. Injectable `runner` option for tests. **[Feature Pass 003]** Passes `{ fix: true, yes: true }` when `lint.auto_fix` is enabled. |
| `daemon/process-manager.ts` | PID/lock file management. Uses `child_process.spawn` with `detached: true` + `stdio: 'ignore'` (not `fork`) so the daemon survives terminal close on every platform including WSL. |
| `daemon/config.ts` | `defaultConfig`, `loadConfig`, `mergeConfig`, `resolveConfigPaths`. **[Phase 6]** Defines the `execution:` block (`mode/cli_path/cli_model/api_key_env`) with `auto` defaults. **[Feature Pass 001]** Adds the `lint:` block (`schedule_enabled`/`interval_hours`) and `ingestion.dead_letter_file` (default `.wotw/failed-batches.jsonl`; empty string disables). **[Feature Pass 003]** Adds the `health:` block (staleness thresholds/scores, weights, duplicate_threshold, auto_fix_staleness_below, max_fixes_per_run, detect_contradictions) and `lint.auto_fix` with deep-merge for health.weights. |

### `src/watcher/` — 4 files

| File | Purpose |
|---|---|
| `watcher/index.ts` | Chokidar watcher subsystem. Emits `WatchEvent`s. **[Phase 6]** Multiplies `debounce_initial_ms` and `debounce_max_ms` by `CLI_DEBOUNCE_MULTIPLIER = 1.5` in CLI mode to coalesce more files per spawn. **[Feature Pass 001]** Tracks deletions and emits `deletedPaths` on the `WatcherBatch` so the queue can run the archive pass. |
| `watcher/debounce.ts` | Exponential-backoff debouncer with burst threshold. **[Feature Pass 001]** Carries deleted paths through the batch alongside add/change paths. |
| `watcher/event-classifier.ts` | Classifies `add|change|unlink` events. |
| `watcher/ignore-patterns.ts` | Gitignore-compatible ignore matching. |

### `src/ingestion/` — 11 files

| File | Purpose |
|---|---|
| `ingestion/index.ts` | Subsystem entrypoint. Wires queue → invoker → writer → committer. |
| `ingestion/queue.ts` | Batch queue. Consumes watcher events, invokes the agent per batch. Resolves model + cliConfig from runtime mode. **[Feature Pass 001]** New `archiveDeletedSources` walks the chain to find every wiki page whose `source_files` included a deleted raw path, rewrites frontmatter to `status: orphaned` + `orphaned_at` + `orphaned_source`, and appends an `"archive"` provenance record with `source_hashes: ["deleted"]` and `model_id: "none"`. Mixed add+delete batches run adds first, archives second, in one queue tick. **Wiki files are never deleted from disk.** Catch blocks now hand permanently-failed batches to `DeadLetterQueue`. |
| `ingestion/llm-invoker.ts` | Dual-mode dispatcher. Routes to CLI invoker or SDK `query()` based on `runtimeMode`. Holds `INGESTION_TOOLS` whitelist; callers may override via `allowedTools`. |
| `ingestion/cli-invoker.ts` | **[Phase 6]** Spawns the local `claude` binary as a subprocess (`--print --dangerously-skip-permissions --model <m>`). User prompt piped on stdin to avoid `ARG_MAX`. Detects writes via before/after wiki-tree snapshot diff. Reports `cost=0` (subscription-covered). |
| `ingestion/dead-letter.ts` | **[Feature Pass 001]** `DeadLetterQueue` JSONL ledger. Records permanently-failed ingestion batches with `timestamp`, `batch_id`, `files`, `reason`, `mode`, `error`, `stack?`, `retry: false`. Empty-string config path disables (every call is a no-op). `count()` is a line count; `list()` skips malformed lines silently; `clear()` is idempotent. Failure to write the ledger logs WARN but never throws — must not take the daemon down. |
| `ingestion/execution-mode.ts` | **[Phase 6]** `findOnPath`, `findApiKey`, `resolveExecutionMode`. Auto-detects CLI binary then API key, refusing with `NO_RUNTIME_AVAILABLE` if neither. Throws typed `ExecutionModeError` with one of three codes. |
| `ingestion/prompt-builder.ts` | Prompt assembly for ingestion agent. |
| `ingestion/wiki-writer.ts` | `reconcileWrittenPages`, `loadAllPages` — reconcile agent-written paths. Uses canonical `path.resolve` + `path.relative` containment check (M-SEC-1). |
| `ingestion/git-committer.ts` | Stages + commits batches. Retries on `index.lock` contention. |
| `ingestion/cost-tracker.ts` | Per-op + daily budget enforcement. Append-only JSONL cost log. `spentToday()` is cached and backed by a shared `sumCostsForDay` helper reused from `wotw status`. (CLI mode logs `cost=0` for every operation; budget never trips.) |
| `ingestion/model-router.ts` | Operation → model id mapping. Pricing table. Cost math. **API MODE ONLY** — CLI mode uses `execution.cli_model` for every operation. |

### `src/wiki/` — 8 files + templates

| File | Purpose |
|---|---|
| `wiki/index.ts` | Subsystem barrel. |
| `wiki/store.ts` | `WikiStore`: category dirs, slug sanitization, read/write/list/count. |
| `wiki/page.ts` | `WikiPage` type, `parsePage`, `serializePage`, `newPage`. **[Feature Pass 001]** Frontmatter now carries optional `status: orphaned`, `orphaned_at`, `orphaned_source` fields written by the deletion archive pass. **[Feature Pass 003]** Supports `status: "merged"` / `"stale"`, plus `merged_into` and `contradictions` frontmatter fields. |
| `wiki/search.ts` | `WikiSearch`: minisearch wrapper with OR-combine, title/tag boosts, snippets. |
| `wiki/index-manager.ts` | Sentinel-delimited `wiki/index.md` generator. |
| `wiki/cross-reference.ts` | Bidirectional `related:` link repair. `[[wiki-link]]` extraction. |
| `wiki/health.ts` | **[Feature Pass 003]** Knowledge health scoring and report generation. `computeStaleness`, `computeSourceAvailability`, `computeLinkHealth`, `computeDuplicateRisk`, `computeWeightedScore`, `computePageHealthScore`, `groupDuplicates` (union-find), `computeHealthReport`. Pure computation + file I/O — no LLM calls. |
| `wiki/heal-handlers.ts` | **[Feature Pass 003]** LLM-powered heal handlers dispatched by `wotw lint --fix`. `healStale`, `healDuplicate`, `healBrokenLinks`, `healMissingBacklinks` (no LLM — deterministic backlink repair), `healContradiction`. `healFinding` dispatcher routes by `finding.kind`. Budget pre-flight, `type: "heal"` provenance, git commits. |
| `wiki/templates/CLAUDE.md` | Default wiki CLAUDE.md seed. |
| `wiki/templates/index.md` | Default wiki index.md seed. |
| `wiki/templates/log.md` | Default wiki log.md seed. |

### `src/server/` — 5 files

| File | Purpose |
|---|---|
| `server/index.ts` | `McpHttpServer` subsystem. HTTP server + stateless MCP transport per request. TokenStore integration. **[Phase 6]** Forwards `runtimeMode` to the internal `QueryEngine`. **[M-SEC-2]** No-auth safety rail: emits a loud WARN banner when started with no auth and refuses to start if `server.host` is non-loopback. **[Feature Pass 001]** Threads `DeadLetterQueue` count through to `get_stats`. |
| `server/middleware.ts` | `RateLimiter`, `runMiddleware`. Returns `{ ok, principal }`. **[F-7]** Legacy single-token branch now uses a constant-time `safeEqual` helper backed by `crypto.timingSafeEqual`. |
| `server/tools.ts` | All 10 MCP tool handlers (search/list/read/query/index/stats/related/provenance-log/verify/synthesize). `resolveWikiPath` uses canonical `path.resolve` + `path.relative` containment check (M-SEC-1). **[Feature Pass 001]** `get_stats` now reports `orphaned_pages` and `failed_batches`. **[Feature Pass 003]** `get_stats` now includes `health: { avg_score, pages_below_50, lowest_scoring_page }`. |
| `server/resources.ts` | MCP resources (index.md as a resource). |
| `server/query-engine.ts` | Natural-language query answering. Retrieves top-k, asks Claude via `invokeIngestionAgent` (with `allowedTools: ["Read","Glob","Grep"]`), returns answer + citations + cost. **[Phase 6]** Branches model selection on `runtimeMode` and skips budget pre-flight in CLI mode. |

### `src/provenance/` — 3 files

| File | Purpose |
|---|---|
| `provenance/index.ts` | Barrel. |
| `provenance/chain.ts` | `ProvenanceChain` — append-only JSONL, single-writer mutex, init/append/verify/recordsFor/readRecent/signature. |
| `provenance/hash.ts` | `GENESIS_HASH`, `canonicalJson`, `sha256Hex`, `sha256Canonical`, `sha256File`, `sha256Files`. |

### `src/compounding/` — 2 files

| File | Purpose |
|---|---|
| `compounding/index.ts` | Barrel. |
| `compounding/engine.ts` | `CompoundingEngine`: `findClusters`, `hasExistingSynthesis`, `synthesize`, `recordProvenance`. Budget-gated, idempotent. **[Phase 6]** Routes through `invokeIngestionAgent` (with `allowedTools: ["Read","Glob","Grep","Write"]`); branches model selection on `runtimeMode` and reads written paths from `result.writtenPaths` instead of parsing assistant messages. |

### `src/multi-user/` — 2 files

| File | Purpose |
|---|---|
| `multi-user/index.ts` | Barrel: re-exports `TokenStore`, `Principal`, `TokenInfo`, `TokenStoreOptions`. |
| `multi-user/token-store.ts` | Atomic JSON token store. `load`, `save`, `authenticate`, `addUser` (issues `wotw_<64hex>`, revokes prior), `revokeToken`, `revokeUser`, `listUsers`, `size`, `clear`. |

### `src/utils/` — 7 files

`src/utils/hash.ts` was deleted in L-DUP-1; the consolidated implementation
lives at `src/provenance/hash.ts`, which re-exports backwards-compatible
aliases (`sha256`, `sha256Json`, `stableStringify`, `sha256FileSync`).

| File | Purpose |
|---|---|
| `utils/types.ts` | All shared types: `WotwConfig`, `WikiPage`, `WikiFrontmatter`, `ProvenanceRecord`, `WatchEvent`, etc. **[Feature Pass 001]** `OperationType` now includes `"archive"`. **[Feature Pass 003]** `OperationType` now includes `"heal"`. `WikiPageStatus` extended with `"merged"` and `"stale"`. `WikiFrontmatter` gains `merged_into` and `contradictions`. `WotwConfig` gains `health:` block and `lint.auto_fix`. |
| `utils/fs.ts` | `expandHome`, `resolvePath`, `ensureDir(Sync)`, `atomicWrite(Sync)`, `readTextOrNull(Async)`, `removeIfExistsSync`, `fileExists`, `dirExists`. |
| `utils/git.ts` | `isGitRepo`, `git(dir)`, `ensureGitRepo`, `commitAll`. Thin wrapper over simple-git. |
| `utils/logger.ts` | pino-based `getLogger(module)`. Wraps pino-pretty in dev. |
| `utils/retry.ts` | `retry(fn, {retries, initialDelayMs, maxDelayMs, factor, shouldRetry, onRetry})`. |
| `utils/sanitize.ts` | Slug, path, and log-output sanitization helpers. The `password-in-url` regex is the strict `scheme://user:pass@host` form (L-SEC-3) so it never matches bare emails or `mailto:`. |
| `utils/version.ts` | Single source of truth for the package version. Uses `createRequire` to read `version` from `package.json` at runtime — can never drift. Consumed by CLI, MCP server, daemon PID file. |

### `src/index.ts`

Library re-export barrel for programmatic consumers of `watcher-on-the-wall`
as an npm package.

---

## 5. Test inventory (every file + count)

**Total: 31 files, ~5,208 LoC, 300 tests — all passing.**

### Unit tests — `test/unit/` — 23 files, 258 tests

| File | Tests | Covers |
|---|---|---|
| `unit/provenance-hash.test.ts` | 16 | `GENESIS_HASH`, `canonicalJson`, `sha256Hex`, `sha256Canonical`, `sha256File`, `sha256Files`. Key-order independence, array handling, file hashing. |
| `unit/provenance-chain.test.ts` | 14 | `init`, `append`, recovery from existing file, `verify` (clean / tampered id / deleted seq / tampered chain_hash), `recordsFor`, `readRecent`, `signature`, concurrent append ordering. |
| `unit/cost-tracker.test.ts` | 11 | `record`, `spentToday`, `wouldExceedDaily`, `checkOperationBudget`, `logUsage`. Uses fake timers to control "today". |
| `unit/model-router.test.ts` | 9 | `PRICING` table, `modelFor`, `pricingFor` fallback, `computeCost` for haiku/sonnet/unknown. |
| `unit/wiki-page.test.ts` | 12 | `parsePage` (with/without frontmatter, invalid category, confidence normalization, string-array filtering, title derivation). `serializePage` round-trip. `newPage` defaults + overrides. |
| `unit/wiki-store.test.ts` | 21 | `sanitizeSlug`, `slugFromPath`, `ensureLayout`, `pathFor`, `readPage`/`writePage` round-trip, `listAll`, `count`, `findByTitle`, `relativePath`. |
| `unit/cross-reference.test.ts` | 13 | `normalizeSlug`, `extractWikiLinks`, `toWikiSlug`, `repairBidirectionalLinks` (add back-ref, already bidirectional, unknown, .md handling, cross-category). |
| `unit/fs-utils.test.ts` | 20 | `expandHome`, `resolvePath`, `ensureDir`, `atomicWrite` (no `.tmp` leftovers), `readTextOrNull`, `fileExists`, `dirExists`, `removeIfExistsSync`. |
| `unit/config.test.ts` | 9 | `defaultConfig` fields, `mergeConfig` deep merge, `resolveConfigPaths` absolute paths, `chain_file` resolved relative to `wiki_root`. |
| `unit/middleware.test.ts` | 14 | `RateLimiter` (capacity, refill, per-key, sweep), `runMiddleware` (rate limit 429, auth 401, `X-Forwarded-For` extraction, TokenStore integration). **[F-7]** Legacy single-token timing-safe accept/reject contract: exact match accepted, same-length wrong bytes rejected, shorter prefix rejected, longer extension rejected, empty bearer rejected, missing header rejected. |
| `unit/token-store.test.ts` | 17 | `load` (empty/existing/malformed), `addUser` (token format, persistence, revoke-on-reissue, multiple users, empty rejection, whitespace trim), `authenticate`, `revokeToken`, `revokeUser`, reload persistence, `clear`. |
| `unit/wiki-search.test.ts` | 14 | `rebuild`, `search` (title/body/OR combine/title-boost/tag-boost/empty/limit/snippet), `upsert`/`remove`. |
| `unit/sanitize.test.ts` | 7 | **[L-SEC-3]** `password-in-url` regex regression suite: matches `https://user:pass@host` and `postgres://u:p@h`, never matches bare emails (`alice@example.com`), `mailto:` links, or already-redacted strings. |
| `unit/execution-mode.test.ts` | 12 | **[Phase 6]** `findOnPath` (fake binary returns null, real `node` binary resolves), `findApiKey` (set/unset/whitespace), `resolveExecutionMode` for all 7 paths: auto-cli, auto-api, auto-fail (`NO_RUNTIME_AVAILABLE`), cli-success, cli-fail (`CLI_BINARY_NOT_FOUND`), api-success, api-fail (`API_KEY_NOT_SET`). |
| `unit/cli-invoker.test.ts` | 7 | **[Phase 6]** `invokeClaudeCli` against fake shell-script `claude` stand-ins. Happy path (stdout captured, written file detected, `cost=0`). Non-zero exit surfaces as `success=false` with `exit_7` stop reason. Timeout-driven SIGTERM with safety-net `setTimeout`. Snapshot diff ignores `.git`/`node_modules`/`raw/`. 256KB stdin prompt round-trip. AbortController cancellation. All Win32-skipped via `it.skipIf(platform() === "win32")`. |
| `unit/lint-scheduler.test.ts` | 6 | **[Feature Pass 001]** `LintScheduler` with injected runner. `schedule_enabled: false` never invokes the runner. `start()` runs once synchronously before its first await. Interval tick triggers a second invocation after `interval_hours`. `getLastResult()` caches the latest result. Runner errors return `null` and leave the cached result alone. `stop()` clears the interval. Uses `vi.useFakeTimers()`. |
| `unit/dead-letter.test.ts` | 7 | **[Feature Pass 001]** `DeadLetterQueue`: empty-string path is `enabled === false` and never touches disk; single record persists with all required fields; multiple records append in order; non-Error inputs are coerced via `toError`; corrupt JSONL lines are skipped silently in `list()`; `list(limit)` slices the tail; `clear()` is idempotent on a missing file. |
| `unit/logs-command.test.ts` | 5 | **[Feature Pass 001]** `wotw logs` default-tail prints the last 20 lines; explicit `--lines` honored; short logs print fully; missing log file warns and exits 0; invalid `--lines` value exits 1 with error. |
| `unit/vault-detect.test.ts` | 10 | **[Feature Pass 002]** `obsidianRegistryPath` override + default non-empty. `findObsidianVaults`: missing registry file returns `[]`, malformed JSON returns `[]`, parses mock registry filtering nonexistent paths and sorting by `ts` desc, skips entries pointing at files (not directories). `findEnclosingVault` finds `.obsidian/` one level up, returns null with no match. `obsidianOpenCommand` URL-encodes the vault path. `openInObsidian` returns boolean and never throws on launcher failure. |
| `unit/init-wizard.test.ts` | 10 | **[Feature Pass 002]** Full non-interactive scaffolding via `runInit({ nonInteractive: true })`: creates every directory + file (config, CLAUDE.md, .gitignore, raw/, wiki/index.md + log.md + 6 category dirs, .obsidian/{app,appearance,graph}.json, .git/); defaults to `process.cwd()` when no `--path`; replaces `__WOTW_UPDATED_ISO__` placeholder in index.md and preserves the sentinel markers; renders `wotw.yaml` with `wiki_root: .` + `raw_path: ./raw`; idempotent re-run preserves a user mutation; `--force` overwrites templates but leaves `.obsidian/` alone; `.gitignore` handling (full file when absent, append on existing without `.wotw/`, no-op when already mentions `.wotw/`); overlay detection preserves a pre-existing `.obsidian/appearance.json` while still scaffolding `raw/` + `wiki/`. |
| `unit/health-scoring.test.ts` | 15 | **[Feature Pass 003]** `computeStaleness` (recent/old/no-provenance/60-day bucket), `computeSourceAvailability` (orphan/no-provenance/all-exist/partial-missing), `computeLinkHealth` (all-valid/2/4-broken/no-links), `computeWeightedScore` (perfect/all-zero/custom-weights), `computePageHealthScore` (structure check). |
| `unit/dedup-detection.test.ts` | 4 | **[Feature Pass 003]** `groupDuplicates`: simple pair, empty input, transitive grouping (A↔B + B↔C → {A,B,C}), independent pairs stay separate. |
| `unit/heal-handlers.test.ts` | 5 | **[Feature Pass 003]** Mock LLM invoker + git-committer. `healStale` prompt shape, `healBrokenLinks` tool whitelist, `healMissingBacklinks` (no LLM, cost=0), `max_fixes_per_run` cap respected, `healDuplicate` merge prompt. |

### Integration tests — `test/integration/` — 8 files, 42 tests

| File | Tests | Covers |
|---|---|---|
| `integration/wiki-pipeline.test.ts` | 4 | End-to-end (no LLM): `ensureLayout` → `writePage` → `reconcileWrittenPages` → `loadAllPages` → `repairBidirectionalLinks` → `indexManager.rebuild` → `search.rebuild` → `chain.append` → `chain.verify`. Plus a canonical-hash verification test that manually computes `sha256Canonical(payload)` and compares to the stored id + chain hash. |
| `integration/compounding-skip.test.ts` | 4 | `CompoundingEngine.synthesize` skip paths: disabled config, not-enough-pages, daily-budget-exhausted, no-clusters-formed. |
| `integration/mcp-server.test.ts` | 15 | Real `McpHttpServer` on ephemeral port. `/healthz` unauth. `/mcp` 401 without bearer. `search` / `get_stats` / `list_pages` / `read_page` tool calls via SDK client. Path-traversal rejection on `read_page` (multiple traversal forms — absolute, encoded, drive-letter). Multi-user: alice + bob authenticate independently, unknown token 401, revoked token 401. **[M-SEC-2]** No-auth + non-loopback host refuses to start. |
| `integration/git-committer.test.ts` | 5 | Real temp git repos. Fresh-dir init. Real file commit after `ensureGitRepo`. Selective staging (alpha + beta committed, gamma left untracked). Idempotent no-op on unchanged files. Rejection of paths outside wiki root. |
| `integration/daemon-wsl-verification.test.ts` | 8 | **[Phase 6]** Documents and verifies the spawn-with-`detached: true` daemon pattern on WSL filesystems: PID file write/parse round-trip, `checkDaemonAlive` for current process, stale PID detection via signal 0 (using `0x7fffffff`), `removePidFile` idempotency, `acquireStartLock` under `/tmp`, mutual exclusion (second acquire rejects), re-acquisition after release, platform sanity check. |
| `integration/deletion-handling.test.ts` | 2 | **[Feature Pass 001]** Full archive pipeline end-to-end: ingest a file, verify provenance + wiki page, delete the source, run the archive pass, assert the wiki page's frontmatter now has `status: orphaned` + `orphaned_at` + `orphaned_source`, the wiki file still exists on disk, an `"archive"` provenance record was appended, and `chain.verify().ok === true` (the new record type does not break canonical hashing). Second test: archive pass with no affected pages is a clean no-op. |
| `integration/health-report.test.ts` | 2 | **[Feature Pass 003]** Full `computeHealthReport` on a 5-page test wiki: verifies scores for all 5 pages, detects orphan finding, detects broken link finding (with page name in description), confirms summary counts match findings, confirms stale findings for pages with no provenance. Second test: minimal 1-page wiki validates summary field types. |
| `integration/lint-fix.test.ts` | 2 | **[Feature Pass 003]** Mock LLM/git/execution-mode. `wotw lint` without `--fix`: reports broken links but doesn't modify disk. `wotw lint --fix --yes`: repairs missing backlinks and verifies the target page's `related:` array now contains the back-reference. |

### Test run output (final, post Feature Pass 003)

```
 ✓ test/integration/compounding-skip.test.ts        ( 4 tests)  240ms
 ✓ test/integration/daemon-wsl-verification.test.ts ( 8 tests)  121ms
 ✓ test/integration/deletion-handling.test.ts       ( 2 tests)  918ms
 ✓ test/integration/git-committer.test.ts           ( 5 tests) 1925ms
 ✓ test/integration/health-report.test.ts           ( 2 tests)  254ms
 ✓ test/integration/lint-fix.test.ts                ( 2 tests)  192ms
 ✓ test/integration/mcp-server.test.ts              (15 tests) 1194ms
 ✓ test/integration/wiki-pipeline.test.ts           ( 4 tests)  401ms
 ✓ test/unit/cli-invoker.test.ts                    ( 7 tests)10178ms
 ✓ test/unit/config.test.ts                         ( 9 tests)   19ms
 ✓ test/unit/cost-tracker.test.ts                   (11 tests)   91ms
 ✓ test/unit/cross-reference.test.ts                (13 tests)   46ms
 ✓ test/unit/dead-letter.test.ts                    ( 7 tests)  164ms
 ✓ test/unit/dedup-detection.test.ts                ( 4 tests)   50ms
 ✓ test/unit/execution-mode.test.ts                 (12 tests) 1616ms
 ✓ test/unit/fs-utils.test.ts                       (20 tests)  185ms
 ✓ test/unit/heal-handlers.test.ts                  ( 5 tests)  372ms
 ✓ test/unit/health-scoring.test.ts                 (15 tests)   42ms
 ✓ test/unit/init-wizard.test.ts                    (10 tests) 2454ms
 ✓ test/unit/lint-scheduler.test.ts                 ( 6 tests)   59ms
 ✓ test/unit/logs-command.test.ts                   ( 5 tests)   81ms
 ✓ test/unit/middleware.test.ts                     (14 tests)  157ms
 ✓ test/unit/model-router.test.ts                   ( 9 tests)   23ms
 ✓ test/unit/provenance-chain.test.ts               (14 tests) 1151ms
 ✓ test/unit/provenance-hash.test.ts                (16 tests)   55ms
 ✓ test/unit/sanitize.test.ts                       ( 7 tests)   20ms
 ✓ test/unit/token-store.test.ts                    (17 tests)  148ms
 ✓ test/unit/vault-detect.test.ts                   (10 tests) 1174ms
 ✓ test/unit/wiki-page.test.ts                      (12 tests)   75ms
 ✓ test/unit/wiki-search.test.ts                    (14 tests)   40ms
 ✓ test/unit/wiki-store.test.ts                     (21 tests)  261ms

 Test Files  31 passed (31)
      Tests  300 passed (300)
   Duration  ~12s
```

Note: `cli-invoker.test.ts` and the abort-controller test inside it
take ~5s each because they SIGTERM a `sleep`-based fake binary; the
real `claude` binary won't use sleep so this is purely a test cost.

---

## 6. Documentation inventory

| File | Purpose | LoC |
|---|---|---|
| `README.md` | Quickstart, feature list, architecture diagram, doc index, license. Updated with dual-mode runtime feature bullet and CLI/API setup options. **[Feature Pass 002]** Quickstart shows interactive `wotw init` + `--yes` non-interactive variant, `raw/notes.md` drop path, and a link to the Obsidian integration guide. | 148 |
| `CHANGELOG.md` | 0.1.0 release notes. Full feature list. | 49 |
| `CONTRIBUTING.md` | **[Feature Pass 001]** Pre-release contributor guide: dev setup, quality gates, code standards, project layout, PR bar. | 165 |
| `SECURITY.md` | **[Feature Pass 001]** Security policy: supported versions, vulnerability reporting, in-scope/out-of-scope, deployment hardening checklist, cryptographic details. **[Audit V2 / F-12]** Token-storage paragraph corrected to describe verbatim `tokens.json` (mode `0600`); race-condition bullet corrected to distinguish `atomicWrite` (wiki + token store) from append-only `appendFile` (cost log + chain + dead-letter). | 113 |
| `ROADMAP.md` | **[Feature Pass 001]** Shipped / In flight / Planned / Won't build buckets with rationale. | 123 |
| `BUILD-SUMMARY.md` | **This document.** Auditable build summary. | (this file) |
| `docs/architecture.md` | Subsystem table, data flow, wiki structure, provenance summary, compounding summary, process model. **[Feature Pass 001]** Subsystem table now includes `lint-scheduler` and `dead-letter`; new "Deletions", "Dead-letter queue", and "Periodic lint" subsections. | 231 |
| `docs/knowledge-health.md` | **[Feature Pass 003]** Full knowledge health system documentation: five scoring factors with weights, staleness day-threshold table, finding kinds and severities, auto-healing handlers, safety guardrails (budget, max_fixes_per_run, provenance), duplicate detection via union-find, contradiction detection, configuration reference, surfacing locations. | 170 |
| `docs/configuration.md` | Full YAML schema with every default — including the Phase 6 `execution:` block. Environment variables. Path resolution rules. Secrets guidance. **[Feature Pass 001]** New `lint:` block and `ingestion.dead_letter_file` documented. **[Feature Pass 003]** New `health:` block and `lint.auto_fix` documented. | 191 |
| `docs/cli-reference.md` | Every CLI command with flags and exit codes. **[Feature Pass 001]** Adds the `wotw logs` subsection and notes that `wotw status` now reports orphan + failed-batch counts. **[Feature Pass 002]** `wotw init` section fully rewritten: 5-row flag table, 8-step wizard flow, non-interactive mode, idempotency guarantees, cross-link to `obsidian-setup.md`. **[Feature Pass 003]** `wotw lint` section rewritten with `--fix`, `--yes`, `--json` flags and heal handler summary. | 256 |
| `docs/obsidian-setup.md` | **[Feature Pass 002]** Full Obsidian integration guide. Registry file locations (macOS / Windows / Linux / WSL), overlay vs fresh vault semantics, subdirectory overlay, `.gitignore` append rules, platform launcher dispatch for `obsidian://open?path=…`, and troubleshooting (missing vaults, wrong `XDG_CONFIG_HOME`, moved vault paths). | 122 |
| `docs/execution-modes.md` | **[Phase 6]** CLI vs API mode comparison table, auto-detection sequence, behavioral differences, recommended setups, troubleshooting guide for `NO_RUNTIME_AVAILABLE` / `CLI_BINARY_NOT_FOUND` / `API_KEY_NOT_SET`. | 120 |
| `docs/mcp-tools.md` | Every MCP tool with input schemas and return shapes. Auth modes. Rate limiting. **[Feature Pass 001]** `get_stats` schema now shows `orphaned_pages` and `failed_batches`. **[Feature Pass 003]** `get_stats` schema now includes `health` object. | 183 |
| `docs/provenance.md` | Record schema (every field), canonical hashing algorithm, chain hashing algorithm, verification algorithm, what a signature proves. **[Feature Pass 001]** `type` enum updated to include `"archive"`; new "Archive records" section. **[Feature Pass 003]** `type` enum includes `"heal"`; new "Heal records" section. | 248 |
| `docs/multi-user.md` | Enabling, provisioning, listing, revoking users. Client configuration. Token format. Storage format. | 144 |

---

## 7. Feature-by-feature delivery

Every user-visible feature with an auditable source location.

| Feature | Implementation | Tested by |
|---|---|---|
| File-watch ingestion with exponential backoff | `src/watcher/index.ts`, `src/watcher/debounce.ts` | Covered via integration-level usage; debouncer has dedicated unit targets in `src/watcher/debounce.ts` |
| **CLI mode 1.5× debounce multiplier** | `src/watcher/index.ts` (`CLI_DEBOUNCE_MULTIPLIER`) | Construction-time logic; Phase 6 |
| Batch queue with agent invocation | `src/ingestion/queue.ts`, `src/ingestion/llm-invoker.ts` | Integration (live LLM in Gate 2) |
| **Dual-mode LLM dispatch (CLI vs API)** | `src/ingestion/llm-invoker.ts`, `src/ingestion/cli-invoker.ts` | `unit/cli-invoker.test.ts` (7 tests, fake `claude` shell-script stand-in) |
| **Auto-detection of execution mode** | `src/ingestion/execution-mode.ts` | `unit/execution-mode.test.ts` (12 tests, all 7 resolution paths) |
| **Subprocess spawn for CLI mode (`--print --dangerously-skip-permissions`)** | `src/ingestion/cli-invoker.ts` | `unit/cli-invoker.test.ts` (happy path + failure modes) |
| **Wiki-tree snapshot diff for write detection (CLI mode)** | `src/ingestion/cli-invoker.ts` (`snapshotTree`, `diffSnapshots`) | `unit/cli-invoker.test.ts` (snapshot diff hygiene test) |
| **Stdin-piped user prompt (avoids `ARG_MAX`)** | `src/ingestion/cli-invoker.ts` | `unit/cli-invoker.test.ts` (256KB stdin test) |
| **Subprocess timeout + AbortController cancellation** | `src/ingestion/cli-invoker.ts` | `unit/cli-invoker.test.ts` (timeout + abort tests) |
| Claude agent session resume (API mode) | `src/ingestion/llm-invoker.ts` (`resume_session` flag) | Live LLM verification |
| Wiki store with category sharding | `src/wiki/store.ts` | `unit/wiki-store.test.ts` (21 tests) |
| YAML frontmatter markdown pages | `src/wiki/page.ts` | `unit/wiki-page.test.ts` (12 tests) |
| Full-text search with OR-combine and boosts | `src/wiki/search.ts` | `unit/wiki-search.test.ts` (14 tests) |
| Sentinel-delimited index.md generator | `src/wiki/index-manager.ts` | Integration via `wiki-pipeline.test.ts` |
| Bidirectional `related:` link repair | `src/wiki/cross-reference.ts` | `unit/cross-reference.test.ts` (13 tests) |
| Reconcile agent-written paths (reject escapes) | `src/ingestion/wiki-writer.ts` | `integration/wiki-pipeline.test.ts` |
| Git commit per batch with retry on lock contention | `src/ingestion/git-committer.ts`, `src/utils/git.ts`, `src/utils/retry.ts` | `integration/git-committer.test.ts` (5 tests) |
| Per-op + daily budget enforcement | `src/ingestion/cost-tracker.ts` | `unit/cost-tracker.test.ts` (11 tests) |
| Model routing + pricing table (API mode only) | `src/ingestion/model-router.ts` | `unit/model-router.test.ts` (9 tests) |
| **Daemon spawn-detached survives terminal close on WSL** | `src/daemon/process-manager.ts` (`child_process.spawn` with `detached: true` + `stdio: 'ignore'`) | `integration/daemon-wsl-verification.test.ts` (8 tests, PID file + lock lifecycle) |
| MCP HTTP server with `/healthz` + `/mcp` | `src/server/index.ts` | `integration/mcp-server.test.ts` (10 tests) |
| Stateless streamable HTTP transport | `src/server/index.ts` (fresh `McpServer` per request) | Integration test |
| Per-IP token-bucket rate limiter | `src/server/middleware.ts` (`RateLimiter`) | `unit/middleware.test.ts` (13 tests) |
| Bearer-token auth (single-token mode) | `src/server/middleware.ts` (`runMiddleware`) | `unit/middleware.test.ts` + `integration/mcp-server.test.ts` |
| Bearer-token auth (multi-user mode) | `src/multi-user/token-store.ts` + `src/server/middleware.ts` | `unit/token-store.test.ts` (17 tests) + `integration/mcp-server.test.ts` (multi-user block) |
| 10 MCP tools (see [§11](#11-mcp-tool-surface)) | `src/server/tools.ts` | Integration test exercises 5 directly; compounding skip tests exercise synthesize path |
| Query engine with retrieval + citations | `src/server/query-engine.ts` | Live LLM verification (Gate 3) |
| SHA-256 canonical-JSON content-addressable hashing | `src/provenance/hash.ts` | `unit/provenance-hash.test.ts` (16 tests) |
| Append-only provenance chain with single-writer mutex | `src/provenance/chain.ts` | `unit/provenance-chain.test.ts` (14 tests, incl. concurrent append) |
| Tamper detection via `chain_hash` | `src/provenance/chain.ts` (`verify`) | `unit/provenance-chain.test.ts` (tampered-id, deleted-seq, tampered-chain-hash tests) |
| Canonical hash reproducibility | `src/provenance/hash.ts` (`canonicalJson`) | `integration/wiki-pipeline.test.ts` ("deterministic record IDs independent of insertion order") |
| Compounding synthesis | `src/compounding/engine.ts` | `integration/compounding-skip.test.ts` (4 tests) + Gate 4 live run |
| Cluster detection by tag | `src/compounding/engine.ts` (`findClusters`) | `integration/compounding-skip.test.ts` ("no clusters") |
| Idempotent synthesis (skip existing) | `src/compounding/engine.ts` (`hasExistingSynthesis`) | Gate 4 live run |
| Multi-user token lifecycle | `src/multi-user/token-store.ts` | `unit/token-store.test.ts` (17 tests) |
| `wotw user add/list/revoke` admin | `src/cli/commands/user.ts` | CLI smoke test (`node dist/cli/index.js user --help`) |
| **Knowledge health scoring** | `src/wiki/health.ts` | `unit/health-scoring.test.ts` (15 tests), `integration/health-report.test.ts` (2 tests) |
| **Deduplication detection (union-find grouping)** | `src/wiki/health.ts` (`groupDuplicates`) | `unit/dedup-detection.test.ts` (4 tests) |
| **Auto-healing via `wotw lint --fix`** | `src/wiki/heal-handlers.ts`, `src/cli/commands/lint.ts` | `unit/heal-handlers.test.ts` (5 tests), `integration/lint-fix.test.ts` (2 tests) |
| **Heal provenance records (`type: "heal"`)** | `src/wiki/heal-handlers.ts` | `unit/heal-handlers.test.ts` |
| **Health summary in `wotw status`** | `src/cli/commands/status.ts` | Manual verification |
| **Health summary in `get_stats` MCP tool** | `src/server/tools.ts` | Manual verification |
| **Daemon lint auto-fix (`lint.auto_fix`)** | `src/daemon/lint-scheduler.ts` | `unit/lint-scheduler.test.ts` (6 tests) |
| 13 CLI subcommands | `src/cli/commands/*.ts` | Gate-1 smoke (`init`/`start`/`stop`/`status`), Gate-2 live (`start` ingesting), Gate-3 live (`query`), Gate-4 live (`audit`/`synthesize`), Phase-5 smoke (`user`) |
| Config discovery via cosmiconfig | `src/daemon/config.ts` | `unit/config.test.ts` (9 tests) |
| Atomic file writes (temp-then-rename) | `src/utils/fs.ts` (`atomicWrite`) | `unit/fs-utils.test.ts` ("no .tmp leftovers") |
| Path-traversal rejection on `read_page` | `src/server/tools.ts` (`resolveWikiPath`) | `integration/mcp-server.test.ts` ("rejects ..") |
| Token file mode 0600 on disk | `src/multi-user/token-store.ts` (`save`) | `unit/token-store.test.ts` |
| pino logger with per-module names | `src/utils/logger.ts` | Used throughout |

---

## 8. Design decisions

Concrete decisions made during the build, with rationale.

**D-01. Stateless MCP transport with fresh `McpServer` per request.**
The `@modelcontextprotocol/sdk` enforces an invariant in stateless
mode (`sessionIdGenerator: undefined`): the same transport cannot be
reused across concurrent requests, because message IDs would collide.
To support multiple CLI clients hitting the daemon concurrently we
construct a fresh `McpServer + Transport` per `/mcp` call. All heavy
state (wiki store, search index, query engine, cost tracker) is shared
via the `ToolRegistrationContext`. See `src/server/index.ts:6-13`.

**D-02. Single-writer promise-chain mutex for provenance appends.**
`ProvenanceChain.append` serializes on a private `writeLock: Promise`
that each append awaits before its critical section runs and that
each caller replaces with its own promise. This guarantees ordered
writes even under N concurrent appenders without a heavier lock.
Verified by `unit/provenance-chain.test.ts` ("concurrent append").

**D-03. Content-addressable canonical-JSON record IDs.**
`id = sha256(canonicalJson(payload_without_id_and_chain_hash))`.
`canonicalJson` recursively sorts keys. This means two processes
building the same payload in different property orders produce the
same id — important for cross-implementation interop and for a future
"multiple daemons agreeing on a single chain" feature.

**D-04. `chain_hash = sha256(previous_chain_hash || id)`.**
Folds the chain hash forward so any mutation of any past record
invalidates every subsequent `chain_hash`. `wotw audit --full` walks
the chain end-to-end and reports the first divergence.

**D-05. Git commits as a secondary audit channel.**
Every ingestion/synthesis batch is committed to git with the operation
id in the message. This gives users a human-friendly history view
(`git log --oneline`) orthogonal to the provenance chain. The provenance
chain is the canonical record; git is the UX.

**D-06. Category-sharded wiki with explicit categories.**
Pages live under `wiki/{concepts,entities,events,decisions,syntheses,other}/`.
Categories are enumerated in a `CATEGORY_DIRS` constant that the
agent is told about via the prompt and that `WikiStore.pathFor`
enforces. This keeps the directory structure predictable and
browsable.

**D-07. Bidirectional link repair is a post-batch step, not an agent
responsibility.** Asking the agent to correctly maintain both sides of
every link is expensive and error-prone. Instead we run a
deterministic `repairBidirectionalLinks` pass after every ingestion
that guarantees: if A lists B in `related:`, then B lists A.
See `src/wiki/cross-reference.ts` and
`unit/cross-reference.test.ts`.

**D-08. Cost tracking is a hard safety rail, not telemetry.**
`CostTracker.checkOperationBudget` is called **before** any LLM
invocation. Exceeding the daily or per-op budget causes the operation
to skip with a structured reason, not to throw. This prevents
runaway spend even in the face of bugs elsewhere.

**D-09. OR-combined natural-language search.**
Minisearch is configured with `combineWith: "OR"` so that
`"what is a hash chain"` matches pages containing `hash chain` even
though `what` and `is` don't appear. Title and tag matches are
boosted to keep relevance sane.

**D-10. Token-bucket rate limiter keyed on `X-Forwarded-For` then
`remoteAddress`.** Per-IP token bucket with capacity and refill rate
equal to `server.rate_limit_rpm`. Old buckets are swept on a timer to
bound memory growth.

**D-11. Multi-user tokens: one active token per user.**
`TokenStore.addUser(user)` revokes any prior tokens for that user
before issuing a new one. This enforces a simple operational
invariant — to rotate a user's credentials you just re-run `wotw user
add <name>`.

**D-12. Bearer token format `wotw_<64hex>`.**
32 bytes of CSPRNG entropy. The `wotw_` prefix exists so you can grep
for leaked tokens in logs, shell history, and git diffs.

**D-13. Atomic file writes via temp-then-rename.**
`atomicWrite` writes to `<path>.<uuid>.tmp` first, then renames.
Cleans up the tmp file on any error. Prevents torn writes on
crash mid-write. See `src/utils/fs.ts`.

**D-14. Detached daemon via fork-exec.**
`wotw start` spawns itself with `WOTW_DAEMON_CHILD=1`; the CLI
entrypoint detects the env var and jumps straight to
`src/daemon/entry.ts`. Single binary, no separate executable.

**D-15. ESLint v9 flat config with calibrated strictness.**
After migrating from the legacy `.eslintrc.cjs`, the aggressive
"recommended-requiring-type-checking" preset was kept but several
noisy rules were disabled (`no-unsafe-assignment`, `unbound-method`,
`require-await`, `no-floating-promises`) because they produced
high-false-positive output on this codebase's pino/minisearch/commander
usage. The rules that catch real bugs were kept:
`no-explicit-any`, `no-unused-vars`, `prefer-const`, `eqeqeq`,
`no-console`, `await-thenable`, `prefer-promise-reject-errors`,
`no-unnecessary-type-assertion`. Real bugs found and fixed during the
migration are listed in [§9](#9-quality-gates--final-verification).

**D-16. Spawn-detached, not fork, for the daemon child.** [Phase 6]
`wotw start` uses `child_process.spawn(process.argv[0], [...], {
detached: true, stdio: 'ignore' })`, not `fork`. Fork opens an IPC
channel between parent and child whose unclosable file descriptor
prevents the parent from exiting on Windows and WSL — the operator
sees `wotw start` "hang" until Ctrl-C, defeating the point of a
detached daemon. `spawn` with `stdio: 'ignore'` cuts every fd between
parent and child, so the parent exits immediately and the child
survives terminal close on every supported platform. Verified by
`integration/daemon-wsl-verification.test.ts`.

**D-17. CLI mode determined once at startup, not per-call.** [Phase 6]
`resolveExecutionMode` runs exactly once during daemon boot and the
resolved mode is threaded into every subsystem via constructor args.
This means the daemon never has to re-detect the runtime in a
hot-path code, the resolved mode is logged exactly once at INFO with
a one-line description, and changing modes requires a daemon restart
(which is the right operational story for a long-running process).
Forced modes (`execution.mode: cli` or `api`) refuse to start with a
typed error rather than silently falling back, so misconfigurations
fail loudly.

**D-18. Wiki-tree snapshot diff to detect CLI-mode writes.** [Phase 6]
The `claude` CLI streams tool-use traffic over stdout/stream-json/text,
none of which is a clean machine-readable contract we want to depend
on across CLI versions. Instead, the invoker takes a `Map<path,
{size, mtimeMs}>` snapshot of the wiki tree before the spawn,
re-snapshots after, and reports any added or modified files. This is
robust to any future change in CLI output format, works in every
output mode, and catches both new files and idempotent re-writes (the
latter via mtime change). The snapshot ignores `.git`, `node_modules`,
and the immutable `raw/` directory.

**D-19. Stdin-piped user prompts.** [Phase 6]
The user prompt for an ingestion batch can easily exceed `ARG_MAX`
(typically 128KB on Linux, 32KB on Windows) when many raw notes are
batched together. Piping the prompt to the CLI's stdin instead of
passing it as an argv entry sidesteps the limit entirely. Verified
by a 256KB stdin test in `unit/cli-invoker.test.ts`.

**D-20. CLI mode skips budget pre-flight; logs cost=0.** [Phase 6]
Every spawn in CLI mode is covered by the user's Claude Pro/Max
subscription — there is no per-call cost to gate against. The cost
tracker still records every operation (so audit trails remain
complete), but the values are always 0 and the budget guards never
trip. The query engine and compounding engine both check
`runtimeMode === "cli"` and skip the budget pre-flight rather than
short-circuiting on a 0 cost (clearer intent in the source).

---

## 9. Quality gates — final verification

All commands were run from the repo root. Output captured on
2026-04-09 after the Feature Pass 003 landing.

### Typecheck

```
$ pnpm typecheck
> tsc --noEmit
(exit 0, no output)
```

### Lint

```
$ pnpm lint
> eslint src test --ext .ts
(exit 0, no output, 0 errors, 0 warnings)
```

### Format check

```
$ pnpm format:check
> prettier --check "src/**/*.ts" "test/**/*.ts"
Checking formatting...
All matched files use Prettier code style!
```

### Tests

```
$ pnpm test
 Test Files  31 passed (31)
      Tests  300 passed (300)
   Duration  ~12s
```

### Build

```
$ pnpm build
> tsup
ESM dist/index.js             ~22 KB
ESM dist/daemon/entry.js     ~169 KB
ESM dist/cli/index.js        ~246 KB
ESM ⚡️ Build success
DTS ⚡️ Build success
```

### CLI smoke

```
$ node dist/cli/index.js --version
0.1.0

$ node dist/cli/index.js --help
Usage: wotw [options] [command]
watcher-on-the-wall — a self-bootstrapping persistent AI knowledge daemon
Commands:
  init        Scaffold a new wiki-store directory in the current project
  start       Start the watcher-on-the-wall daemon
  stop        Stop the watcher-on-the-wall daemon
  status      Show daemon health and wiki stats
  query       Ask the wiki a natural-language question
  audit       Walk the cryptographic provenance chain for a wiki page
  lint        Run health checks over the wiki
  install-hook    Install a Claude Code SessionStart hook that boots the daemon
  uninstall-hook  Remove the Claude Code SessionStart hook
  serve       Start a standalone MCP server
  synthesize  Run a compounding synthesis pass over the wiki
  user        Manage multi-user authentication tokens
  help [command]  display help for command

$ node dist/cli/index.js user --help
Commands:
  add <name>      Issue a new token for a user (prints the token)
  list [options]  List active users and token creation times
  revoke <name>   Revoke all tokens for a user
```

### Real bugs found and fixed during Phase 5

These were latent bugs caught by the lint migration; every one was
fixed at its root location (not suppressed).

| Bug | Location | Fix |
|---|---|---|
| `await` on a sync function | `src/provenance/chain.ts:91` (`await fileExists(...)` — `fileExists` is sync) | Dropped the `await`. |
| `await` on a sync function | `src/provenance/chain.ts:279` (same) | Dropped the `await`. |
| `reject` called with non-Error | `src/server/index.ts:281` (`readJsonBody` — `reject(err)` where `err` had type `unknown`) | Wrapped: `reject(err instanceof Error ? err : new Error(String(err)))`. Also converted `req.on("error", reject)` to use a typed arrow. |
| Unnecessary `as number` assertion | `src/cli/commands/audit.ts:172` | Removed the cast; the narrowed type already provides it. |
| Unnecessary `as object` assertion | `src/utils/hash.ts:43, 46` (WeakSet operations) | Removed the casts; `v` is already `object` at that point. |
| Unnecessary `as keyof typeof CATEGORY_DIRS` assertion | `src/server/tools.ts:197` | Removed; `cat` is already the right type. |
| ESLint v9 migration | Project root | New `eslint.config.js` flat config; new `tsconfig.eslint.json` to include tests in the project; `@eslint/js` + `globals` packages added. |

---

## 10. CLI surface

Full list of `wotw` subcommands registered in `src/cli/index.ts`.
Each one dispatches to a file under `src/cli/commands/`.

| Command | File | Description |
|---|---|---|
| `wotw init [dir] [-p/--path <dir>] [-y/--yes] [--no-open] [-f/--force]` | `init.ts` | **[Feature Pass 002]** Obsidian-aware interactive setup wizard. Detects Obsidian vaults from the registry, offers overlay into existing vaults or fresh vault creation, silently detects runtime (CLI vs API), scaffolds the layout with a spinner, and optionally launches Obsidian via `obsidian://open`. Non-interactive mode available via `--yes` or absent TTY. Idempotent on re-run. |
| `wotw start` | `start.ts` | Fork detached daemon child (or run foreground with `--foreground`) |
| `wotw stop` | `stop.ts` | SIGTERM the daemon via PID file |
| `wotw status [--watch] [--json]` | `status.ts` | Snapshot: uptime, queue depth, today's cost, page counts, provenance head |
| `wotw query <question> [--k N]` | `query.ts` | Natural-language query over the wiki via MCP client |
| `wotw audit [page] [--full] [--limit N]` | `audit.ts` | Walk provenance chain (for a page or the whole chain) |
| `wotw lint [--fix] [--yes] [--json]` | `lint.ts` | **[Feature Pass 003]** Run wiki health checks. `--fix` heals auto-fixable findings (LLM-powered). `--yes` skips confirmation. `--json` outputs machine-readable JSON. |
| `wotw logs [-n N] [-f/--follow]` | `logs.ts` | Tail the daemon's rotating log file (Feature Pass 001) |
| `wotw install-hook` | `install-hook.ts` | Install Claude Code SessionStart hook that boots the daemon |
| `wotw uninstall-hook` | `uninstall-hook.ts` | Remove the Claude Code SessionStart hook |
| `wotw serve [--port N] [--host H]` | `serve.ts` | Standalone MCP server (no watcher, no ingestion) |
| `wotw synthesize [--force]` | `synthesize.ts` | Trigger a compounding synthesis pass |
| `wotw user add <name>` | `user.ts` | Issue a new token for a user |
| `wotw user list [--json]` | `user.ts` | List active users |
| `wotw user revoke <name>` | `user.ts` | Revoke all tokens for a user |

Top-level flags: `-v / --version`, `-h / --help`.

---

## 11. MCP tool surface

All 10 tools registered in `src/server/tools.ts`.

| Tool | Description | Input schema (zod) |
|---|---|---|
| `search` | Full-text search with ranked hits + snippets | `{ query: string.min(1), limit?: int(1..100) }` |
| `list_pages` | List every page, optional category filter | `{ category?: enum }` |
| `read_page` | Read a single page by wiki-relative path (rejects `..`) | `{ path: string.min(1) }` |
| `query` | Natural-language question → grounded answer with citations | `{ question: string.min(1), k?: int(1..20) }` |
| `get_index` | Current contents of `wiki/index.md` | `{}` |
| `get_stats` | Counts by category + today's cost + indexed document count | `{}` |
| `related_pages` | `related:` / `tags:` / `sources:` for a given page | `{ path: string.min(1) }` |
| `get_provenance_log` | Recent provenance records (or records for a specific page) | `{ limit?: int(1..500), path?: string }` |
| `verify_provenance` | Walk chain end-to-end, report tampering | `{}` |
| `synthesize` | Trigger a compounding synthesis pass | `{}` |

Endpoints:
- `GET /healthz` — unauthenticated liveness probe
- `POST /mcp` — authenticated MCP streamable-HTTP transport

---

## 12. Configuration surface

Every config key with its default (from `defaultConfig()` in
`src/daemon/config.ts`).

```yaml
wiki_root: ./wiki-store
raw_path: ./wiki-store/raw

# [Phase 6] Runtime selector — picks the host that runs every Claude
# agent loop. Auto-detects on startup; force `cli` or `api` to pin.
execution:
  mode: auto                   # auto | cli | api
  cli_path: claude             # binary name or absolute path
  cli_model: claude-sonnet-4-5 # model passed to `claude --model` in CLI mode
  api_key_env: ANTHROPIC_API_KEY

# API MODE ONLY — in CLI mode every operation uses execution.cli_model.
models:
  ingest:        claude-haiku-4-5
  query:         claude-sonnet-4-5
  lint:          claude-sonnet-4-5
  compound_eval: claude-haiku-4-5

watcher:
  debounce_initial_ms: 5000
  debounce_max_ms: 60000
  debounce_growth_factor: 1.5
  burst_threshold: 5
  max_batch_size: 20
  ignore_patterns: ["**/.git/**", "**/node_modules/**", "**/.DS_Store", "**/Thumbs.db"]

ingestion:
  max_turns: 50
  max_budget_per_batch_usd: 1.0
  resume_session: true
  dead_letter_file: .wotw/failed-batches.jsonl  # Feature Pass 001; empty string disables

cost:
  max_daily_usd: 10.0
  max_per_query_usd: 0.5
  max_per_ingest_usd: 2.0
  track_file: ~/.wotw/cost-log.jsonl

server:
  port: 8787
  host: 127.0.0.1
  auth_token: null
  rate_limit_rpm: 60

daemon:
  pid_file:  ~/.wotw/daemon.pid
  lock_file: ~/.wotw/daemon.lock
  log_file:  ~/.wotw/daemon.log
  log_level: info

compounding:
  enabled: true
  min_source_pages: 3
  confidence_threshold: 70

# [Feature Pass 001] Periodic lint scheduler. Off by default; when
# enabled, the daemon runs `wotw lint` every N hours via setInterval.
lint:
  schedule_enabled: false
  interval_hours: 24
  auto_fix: false                # [Feature Pass 003] when true, scheduler runs lint --fix --yes

# [Feature Pass 003] Knowledge health scoring and auto-healing.
health:
  staleness_thresholds: [7, 30, 90, 180, 365]
  staleness_scores: [100, 80, 60, 40, 20, 0]
  weights:
    staleness: 0.25
    source_availability: 0.25
    link_health: 0.20
    duplicate_risk: 0.15
    contradiction_risk: 0.15
  duplicate_threshold: 60
  auto_fix_staleness_below: 40
  max_fixes_per_run: 10
  detect_contradictions: false

provenance:
  enabled: true
  chain_file: provenance-chain.jsonl    # resolved relative to wiki_root
  verify_on_startup: false

multi_user:
  enabled: false
  workspaces_dir: ~/.wotw/workspaces
```

Environment variables consumed: `ANTHROPIC_API_KEY` (only when
`execution.mode` resolves to `api`; the var name is configurable via
`execution.api_key_env`), `WOTW_DEBUG`, `WOTW_CONFIG`,
`WOTW_DAEMON_CHILD` (internal).

Config discovery order (cosmiconfig): `package.json` key → `.wotwrc*`
→ `wotw.config.{json,yaml,yml}`.

Path resolution: `~` expansion, relative paths against the config
file's directory, `provenance.chain_file` specifically resolved
against `wiki_root`.

---

## 13. Provenance format

Every record on `provenance-chain.jsonl` is a single JSON line:

```json
{
  "seq": 1,
  "id": "sha256(canonicalJson(payload_without_id_and_chain_hash))",
  "timestamp": "ISO-8601 UTC",
  "type": "ingest | query | compound | archive | heal",
  "source_files": ["wiki-relative paths"],
  "source_hashes": ["sha256 per source file"],
  "prompt_hash": "sha256 of exact prompt bytes",
  "model_id": "e.g. claude-haiku-4-5",
  "response_hash": "sha256 of raw agent response",
  "wiki_files_written": ["wiki-relative paths"],
  "wiki_file_hashes_after": { "path": "sha256 after write" },
  "previous_id": "id of seq-1 | null",
  "previous_chain_hash": "chain_hash of seq-1 | GENESIS_HASH",
  "chain_hash": "sha256(previous_chain_hash || id)",
  "metadata": { "cost_usd": 0.012, "user": "alice" }
}
```

- `GENESIS_HASH = "0".repeat(64)`
- `id` uses `canonicalJson` (recursive key sort) so it's insertion-order
  independent.
- `chain_hash` folds forward, so any past-record mutation is
  immediately detectable.
- `wotw audit --full` recomputes every field and reports the first
  divergence.

---

## 14. Dependencies

**Runtime deps (from `package.json`):**

- `@anthropic-ai/claude-agent-sdk ^0.2.92` — agent session runner
- `@anthropic-ai/sdk ^0.82.0` — raw Anthropic client
- `@modelcontextprotocol/sdk ^1.0.4` — MCP server + client
- `boxen ^8.0.1` — CLI UI
- `chalk ^5.4.1` — CLI colors
- `chokidar ^4.0.3` — file watcher
- `commander ^12.1.0` — CLI framework
- `cosmiconfig ^9.0.0` — config discovery
- `gray-matter ^4.0.3` — YAML frontmatter parser
- `minisearch ^7.1.1` — full-text search
- `ora ^8.1.1` — CLI spinner
- `p-queue ^8.0.1` — promise queue
- `pino ^9.5.0` + `pino-pretty ^13.0.0` — structured logger
- `proper-lockfile ^4.1.2` — PID/lock file
- `simple-git ^3.27.0` — git wrapper
- `yaml ^2.6.1` — YAML parser for config
- `zod ^4.3.6` — schema validation

**Dev deps:**

- `typescript ^5.7.2`, `tsup ^8.3.5`, `tsx ^4.19.2`
- `vitest ^2.1.8`
- `eslint ^9.17.0`, `@eslint/js ^9.17.0`, `globals ^15.14.0`,
  `@typescript-eslint/{parser,eslint-plugin} ^8.18.2`
- `prettier ^3.4.2`
- `@types/node ^22.10.2`, `@types/proper-lockfile ^4.1.4`

---

## 15. Known gaps and deferred items

These were consciously scoped out of v0.1.0 and are the natural next
steps. Nothing in this list is broken; everything is "not yet built".

- **Hot reload on multi-user token store.** Today the server loads
  `tokens.json` once at startup. `wotw user revoke` updates the file,
  but a running server must be restarted for the revocation to take
  effect. Planned: `SIGHUP` reload or file-watching.
- **Per-user workspace overlays.** `workspaces_dir` currently only
  holds the token store. The planned next step is to let each
  authenticated user see a private overlay on top of the shared wiki.
- **Provenance chain rotation.** The chain grows forever. `wotw
  provenance rotate` would archive the current chain and start a new
  one whose seq-1 record's `previous_chain_hash` equals the archived
  chain's final `chain_hash`.
- ~~**`wotw lint` details.**~~ Resolved in Feature Pass 003 —
  `docs/knowledge-health.md` covers the full health system.
- **`wotw install-hook` details.** Same — command works; dedicated
  doc would help.
- **Cost-tracking, compounding, query-engine docs.** All three are
  covered at subsystem level in `docs/architecture.md`, but each
  deserves a dedicated doc page.
- **Deployment guide (systemd, Docker).** Not written.
- **Library API docs.** `src/index.ts` exports a programmatic API;
  no dedicated doc yet.
- **Coverage report publishing.** Vitest is configured with v8
  coverage, but CI doesn't upload it.
- **Pre-commit hook for lint/format.** Not installed.
- **Benchmarks.** No performance benchmarks.

---

## Auditing this document

Every numeric and textual claim in this document was captured from
the working tree at `/home/jgoodman/watcher-on-the-wall`. To
reproduce the key measurements:

```bash
# File counts
find src -name "*.ts" | wc -l                                 # -> 65
find test -name "*.ts" | wc -l                                # -> 31
find docs -name "*.md" | wc -l                                # -> 9

# Line counts
find src -name "*.ts" -exec wc -l {} + | tail -1              # -> ~10831 total
find test -name "*.ts" -exec wc -l {} + | tail -1             # -> ~5208 total
wc -l docs/*.md README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md ROADMAP.md | tail -1  # -> ~2100 total

# Gates
pnpm typecheck                                                # 0 errors
pnpm lint                                                     # 0 errors, 0 warnings
pnpm format:check                                             # clean
pnpm test                                                     # 300/300 passing
pnpm build                                                    # success

# CLI smoke
node dist/cli/index.js --version                              # -> 0.1.0
node dist/cli/index.js --help
node dist/cli/index.js user --help
```

Every source file listed in [§4](#4-source-inventory-every-file) and
every test file listed in [§5](#5-test-inventory-every-file--count)
exists on disk. Every feature in [§7](#7-feature-by-feature-delivery)
points at a real implementation file. Every bug in the "real bugs
fixed" table in [§9](#9-quality-gates--final-verification) points at
a real line number in the committed code.
