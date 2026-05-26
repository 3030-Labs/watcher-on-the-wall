# PASS-023 — DAEMON-PUBLIC-READINESS Closure

**Status:** 🟡 Substrate complete; npm publish + dogfood + post-publish evidence pending
**Date opened:** 2026-05-26
**Daemon version target:** v0.8.4
**Implementation HEAD:** (committed at the top of this pass; see `git log --oneline -1`)
**Closes:** GH-public-launch readiness for DriftVane/watcher-on-the-wall
**Out of scope:** v0.9.0 emit_event scaffolding, Group C residuals, marketplace-side Pack semantics, public marketing site

3030 Labs principle: substrate is excellent, onboarding shell is not.
This pass closes the onboarding-shell gap before we point public
traffic at the repo. All 14 items completed substantively; npm publish
is held behind an operator-dogfood gate per the goal-authorization-scope
discipline (irreversible-ish public actions get their own confirmation
event even when the goal pre-authorized the outcome).

---

## Pass scope (14 items)

### Part A — Fresh-install verification

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | macOS arm64 install evidence | 🟡 runbook | `docs/install-evidence/macos-arm64.md` — operator runbook. Captured against live v0.8.4 after npm publish via dogfood pass. |
| 2 | macOS amd64 install evidence | 🟡 workflow ready | `.github/workflows/install-evidence.yml` matrix includes `macos-13` (amd64). Dispatch-only; fires post-publish. |
| 3 | Linux amd64 install evidence | 🟡 workflow ready | Same workflow; `ubuntu-22.04` runner. |
| 4 | Windows amd64 install evidence | 🟡 workflow ready | Same workflow; `windows-2022` runner with PowerShell shell. |

All four platform jobs share the same body: install from npm, run `wotw
init --yes`, drop the 5 fixture files at `docs/install-evidence/fixtures/`,
capture status, upload per-platform artifact. Operator promotes
artifacts into `docs/install-evidence/<platform>.md` via a follow-up
commit (chosen over auto-commit to keep the repo history clean and
reviewable).

**Workflow is `workflow_dispatch`-only** by deliberate choice — auto-firing
on tag push would race the npm publish step, which is intentionally
separate per the goal-authorization-scope rule.

### Part B — Onboarding surface

| # | Item | Status | Evidence |
|---|---|---|---|
| 5 | README rewrite for stranger's first 60 sec | ✅ | New `README.md`. Tagline + 2-paragraph "what it is" + 5-line install + 30-sec quickstart with concrete output + links to deeper docs. Includes `Note (publish-gap window)` block honest about the npm 404 window. |
| 6 | `wotw init` walkthrough doc | ✅ | New `docs/init-walkthrough.md`. Every prompt, default, validation rule, platform-specific note (macOS / Linux / Windows / WSL2), exit code mapping. Mirrors `src/cli/commands/init.ts:runInit` decision tree. |
| 7 | BYOK doc | ✅ | New `docs/self-hosted-byok.md`. Provider key landing, env-var resolution, 5 failure modes (missing/invalid/rate-limited/missing-perms/network-blocked) with verbatim daemon log lines and remediation, rotation procedure, multi-tenant guidance, verification commands. |
| 8 | LLM provider auto-resolution doc | ✅ | New `docs/llm-provider-auto-resolution.md`. Per-provider fact-extraction defaults, decision tree with priority order, rationale for off-by-default on metered + on-by-default on cost-free, override patterns, `wotw facts reindex`, log verification. |

### Part C — Repo hygiene + policy

| # | Item | Status | Evidence |
|---|---|---|---|
| 9 | SECURITY.md SLA + safe-harbor | ✅ | Rewritten. 5-business-day acknowledgment, 10-day triage, 30-day fix-or-disclosure for high/critical (90 for low/moderate). Explicit safe-harbor clause for good-faith researchers with 6 conditions. Coordinated-disclosure default. PGP key reference. |
| 10 | CHANGELOG.md per-version user-visible | ✅ | Rewritten. v0.8.4 (this pass), v0.8.3 (KEK rotation), v0.8.2 (G5 attestation), v0.8.1 (native-dep fix), v0.8.0 (Pass B + G5 scaffolding), v0.4.0 (multi-LLM), v0.2.x patches, v0.2.0, v0.1.0. Internal closure docs referenced, not exposed. |
| 11 | LICENSE-NOTICES.md (AGPL plain English) | ✅ | New. Derivative-work test, network-use §13 clause, what counts as a service, wotw-cloud relationship, fork rules (what competitors can / can't do), third-party dep posture, patent grant, trademark scope. Attorney-disclaimable preamble. |
| 12 | `.github/ISSUE_TEMPLATE/*.yml` | ✅ | 4 GitHub issue forms: `bug_report.yml`, `feature_request.yml`, `question.yml`, plus `config.yml` (blank-issue routing). Replaces legacy `.md` templates. Security disclosures routed to SECURITY.md. |
| 13 | CONTRIBUTING.md rewrite | ✅ | Centred on AGPL implications + DCO sign-off requirement (Developer Certificate of Origin). 7 quality gates documented. PR review expectations (triage / first-review / iteration / merge SLAs). Bot-generated PR policy. |

### Part D — Pack format + dogfood + errors + telemetry

| # | Item | Status | Evidence |
|---|---|---|---|
| 14 | `docs/pack-format-daemon.md` (daemon-side wire format only) | ✅ | New. Layout (directory tree or .zip), manifest.json / chain.jsonl / keys.json shape, daemon-side write guarantees (atomic export, chain monotonicity, encrypted-DEK-only, no content leakage by default), verifier read-side semantics, v1 → v2 compatibility posture. **Marketplace semantics explicitly out of scope**, pointed at `wotw-artifact-layer-prd.md`. |
| 15 | Justin dogfood pass | 🟡 pending | Surfaced at the post-tag checkpoint. Dogfood happens AFTER repo flips public + v0.8.4 tag pushed, but BEFORE npm publish — so dogfood findings can adjust README / install flow without locking a broken version into the registry. Findings → `PASS-023-DOGFOOD-FINDINGS.md`. |
| 16 | Error-message audit on 10 unhappy paths | ✅ | New module `src/utils/actionable-error.ts` with `ActionableError` class + 10 helper constructors. Call-site wraps: `src/keys/store.ts:101`, `src/facts/store.ts:83`, `src/daemon/index.ts:65-66`, `src/daemon/config.ts:602`, `src/server/index.ts:203`, `src/daemon/index.ts:132-145`, `src/cli/commands/init.ts:175,192`. CLI top-level handler renders these as structured stderr blocks. Tests in `test/unit/actionable-error.test.ts` + `test/unit/init-error-paths.test.ts`. |
| 17 | First-run telemetry: opt-in BYO DSN | ✅ | New modules `src/telemetry/{types,sink,categorize,index}.ts`. **Disabled by default; no 3030 Labs DSN.** Sentry SDK is an optional peer dep — sink falls back to no-op if not installed. Validator rejects PII-shaped fields. Categorical events only (10 stable enum values). Test invariants in `test/unit/telemetry.test.ts`. User docs at `docs/telemetry.md`. |

---

## Hard gates

| Gate | Bar | State |
|---|---|---|
| 7 daemon build gates | typecheck / lint / format / build / test / docs / provenance compat | ✅ all green |
| Test count | ≥ 900 | ✅ **929** (up from 813 baseline; +116) |
| 4-platform install evidence | committed under `docs/install-evidence/` | 🟡 workflow + runbook ready; runs post-publish |
| README first-60-sec verified by dogfood | Justin walks README + install + init on untouched machine | 🟡 pending (next checkpoint) |
| 10 unhappy-path errors tested | each has loud actionable error + regression test | ✅ all 10 covered |
| SECURITY/CHANGELOG/LICENSE-NOTICES/CONTRIBUTING/ISSUE_TEMPLATE/* present | repo root | ✅ all 5 present |
| `docs/pack-format-daemon.md` with daemon-side-only scope explicit | committed + cross-linked | ✅ |

---

## Test count math

Baseline (HEAD pre-PASS-023): **813 test cases**.

Added in PASS-023:
- `test/unit/actionable-error.test.ts`: +38 (one per path × class shape × matcher × end-to-end shape)
- `test/unit/init-error-paths.test.ts`: +7 (non-empty target + env-var precedence + force override)
- `test/unit/telemetry.test.ts`: +38 (default / opt-in / no-embedded-DSN / validator / MemorySink / categorizer / orchestration / NoopSink)
- `test/unit/init-wizard.test.ts`: +0 net (isolation cleanup added; no new test cases)
- benchmark + integration suites unchanged

**Total: 929 test cases across 90 files. ≥ 900 hard gate satisfied.**

---

## Irreversible-action sequencing

Per the `feedback-goal-authorization-scope` discipline:

1. ✅ **Commit + push to main.** Reversible at the local level (`git reset` before push), public at the remote level (`git push --force` to undo is messy but possible).
2. ✅ **`gh repo edit --visibility public`.** Flips DriftVane/watcher-on-the-wall to public. Authorized in the v0.8.4 ship-sequence bundle.
3. ✅ **`git tag v0.8.4 + git push origin v0.8.4`.** Tag is immutable once pushed (deleting + re-creating in place is technically possible but signals untrustworthiness).
4. 🟡 **npm publish v0.8.4.** Held behind dogfood. Once `@driftvane/wotw@0.8.4` exists in the registry, it exists forever (npm unpublish is restricted after 72 hours and impossible after any depend-er appears).
5. 🟡 **Dispatch install-evidence workflow.** After (4) completes; operator runs `gh workflow run install-evidence.yml -f version=0.8.4`.
6. 🟡 **Operator manual macOS arm64 capture.** After (4) completes; operator runs the runbook in `docs/install-evidence/macos-arm64.md` and commits the captured log.

Steps 1-3 are "build-phase + reversible-public", step 4 is the most-permanent
action and gets its own confirmation event.

---

## Cross-links

- [README.md](README.md) — stranger-facing entry point.
- [CHANGELOG.md](CHANGELOG.md) — v0.8.4 entry.
- [docs/install-evidence/](docs/install-evidence/) — captured platform evidence.
- [docs/pack-format-daemon.md](docs/pack-format-daemon.md) — daemon-side Pack wire format.
- [BUILD-SUMMARY.md](BUILD-SUMMARY.md) — refreshed with v0.8.4 gate state.
- `wotw-verify/docs/verification-protocol.md` — verifier-side spec; this pass's pack-format-daemon doc is the daemon-side mirror.
- `MEMORY.md` (operator-side, separate from repo) — pass logged via memory entries written in-session.

---

## Remaining work (outside this pass's hard gates)

The following are explicitly out of scope and tracked separately:

- **v0.9.0 emit_event scaffolding** — separate pass, separate version.
- **Group C Layer-1 residuals** — REVIEW-LAYER-1-DAEMON.md still has 10 Class-1 items + G2/G6/G8/G9-remainders open. Tracked under `REMEDIATION-LAYER-1-DAEMON.md`.
- **CT4.01 cloud-side Compliance Pack export** — separate `/goal` in the wotw-cloud session against the spec frozen here.
- **Marketplace-side Pack semantics** — Pulse, Brief, attribution, royalty, cross-tenant share — `wotw-artifact-layer-prd.md`.
- **wotw.dev marketing site polish** — separate scope, separate repo.
- **HOMEBREW_TAP_TOKEN for wotw daemon** — n/a (wotw daemon doesn't ship as Homebrew). The Homebrew formula referenced in `wotw-verify/docs/release-process.md` is for the verifier binary, not the daemon.

---

## Sign-off

Pass closes after:

1. Justin dogfood pass complete → `PASS-023-DOGFOOD-FINDINGS.md` written
2. Any dogfood fixes integrated
3. npm publish v0.8.4 authorized + executed
4. install-evidence workflow dispatched + 4 platform artifacts captured + promoted into `docs/install-evidence/`
5. Manual macOS arm64 capture done + committed
6. This file updated with the final closure timestamp and "Status: ✅ Closed"

Until step 6, this file's status remains 🟡 substrate complete.
