# Multi-LLM Verify-and-Harness Arc — PHASE 4: CI integration

**Date:** 2026-05-31
**Branch:** `multi-llm-harness` (P1 `27248bf`, P2 `3237a69`, P3 `b45cec7`)
**Scope:** wire the gold-fact harness into CI — an offline cassette PR-gate that
fails on regression, with key-gated graceful live-skip, plus a separate scheduled
live drift run.

---

## Outcome

The PR-gate is an **offline cassette-replay vitest test**
(`test/harness/replay-gate.test.ts`) that runs inside the existing `pnpm test`
CI job. It scores every recorded cassette against gold and fails the PR if any
fixture regresses below its recorded baseline beyond the margin — deterministic,
free, and **zero external API calls**, so a flaky provider can never block a
merge. Live model drift is handled separately by a **scheduled weekly workflow**
(`.github/workflows/multi-llm-drift.yml`) that is key-gated and non-PR-gating.

All three gate conditions were proven, not asserted:
1. **PR-gate blocks on regression** — a controlled demo degraded one committed
   cassette to a single fact; the replay-gate test FAILED
   (`recall 0.000 < baseline 1.000 - 0.1`); `git checkout` restored it → green.
2. **Live-skip graceful on absent keys** — `run-harness --runtime api --provider
   openai` with no key returned all SKIP (`ran=true llm_error`), exit 0 — no
   crash, no false regression.
3. **Scheduled workflow valid** — both workflow YAML files parse.

Test total: **1015 → 1019** (+4 replay-gate assertions). Five gates green.

---

## Gate evidence

| Gate | Status | Evidence |
|---|---|---|
| Cassette PR-gate blocks on regression | ✓ | Degraded `01-tardigrades` cassette → `replay-gate.test.ts` failed with the exact baseline-drop reason; restored → 4 passed. Runs in `pnpm test` → fails the PR. |
| PR-gate is offline / deterministic | ✓ | Reads committed cassettes + baselines only; no network. Runs on every push/PR via the existing `ci.yml` `pnpm test` step. |
| Live-skip graceful on absent keys | ✓ | `run-harness --runtime api --provider openai` (no key) → all SKIP, exit 0. Workflow also guards: empty `ANTHROPIC_API_KEY` → `::notice` + exit 0. |
| Scheduled live workflow valid | ✓ | `multi-llm-drift.yml` (weekly cron `0 6 * * 1` + `workflow_dispatch`) parses; runs the live API extractor in `check` mode, non-PR-gating. |
| Intentional-regression catch (mechanism) | ✓ | `harness.test.ts` + the controlled cassette demo both exercise the same `checkRegression` path the PR-gate uses. |
| `test` / `typecheck` / `lint` / `format` / `build` | ✓ | 1019 passed; tsc/eslint/prettier/tsup clean. |

---

## Defects against canon

| Canon | Class | Firing | Resolution |
|---|---|---|---|
| `feedback_artifact_validation_gates` | application | A green PR-gate test proves nothing if it cannot fail. | Validated the GATE itself: degraded a real cassette and confirmed the committed test fails, then restored. The success criterion (no regression) is matched to the real job (detect a degraded extraction), not a proxy. |
| `feedback_fail_loud_never_fake` (verify-before-assert) | application | "Live-skip graceful" could hide a silently-broken live run. | The skip is explicit (`::notice` in CI, `SKIP ... llm_error` rows locally) and only suppresses the absent-key case; a real regression with a key present still turns the run red. |
| `feedback_open_the_box_before_changing` | application | — | The PR-gate runs the real committed cassettes through the real scorer/regression code, not a mock of them. |

---

## Infrastructure state

- Branch `multi-llm-harness`; **no push** (one human-gated push at arc close).
- CI: `ci.yml` `pnpm test` now includes the offline PR-gate (no workflow change
  needed — it is a vitest test). New `multi-llm-drift.yml` scheduled workflow added.
- The scheduled live run needs an `ANTHROPIC_API_KEY` repo secret to do anything;
  absent it, it self-skips.

---

## Code landed

**Added:**
- `test/harness/replay-gate.test.ts` — offline cassette PR-gate (4 assertions:
  baseline present, corpus integrity, no-regression, no-orphan-cassettes).
- `.github/workflows/multi-llm-drift.yml` — scheduled weekly live drift run
  (key-gated, non-PR-gating, `check`/`record` via dispatch input).
- `MULTI-LLM-HARNESS-PHASE-4.md` — this closure doc.

**Test totals:** 1019 (was 1015; +4; no deletions).

---

## Outstanding with hard gates

- **API-mode / non-Anthropic baselines.** The scheduled workflow runs the API
  path; committed baselines are CLI-recorded. The first keyed live run should
  `record` an api-mode baseline (or an operator re-baselines) so drift `check`
  compares like-for-like. OpenAI/Gemini baselines need their keys; Ollama needs a
  running server. All key/server-gated — the harness skips them cleanly until then.

---

## Notes for review

- The PR-gate lives in `pnpm test` deliberately — no separate CI step to forget,
  and it gates locally too. The scheduled drift run is the only piece that needs
  a secret, and it degrades to a no-op without one.
- The cassette-vs-baseline comparison is most valuable across TIME: when a future
  change re-records cassettes (e.g. a prompt edit) and quality drops, the PR-gate
  catches it against the prior baseline. For THIS commit the cassettes and
  baselines are mutually consistent (replay = 0 regressions).
