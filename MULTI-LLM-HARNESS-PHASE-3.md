# Multi-LLM Verify-and-Harness Arc — PHASE 3: Gold-fact regression harness

**Date:** 2026-05-31
**Branch:** `multi-llm-harness` (P1 `27248bf`, P2 `3237a69`)
**Scope:** the real new code — a standing 20-fixture gold-fact corpus + a
per-provider fact-level regression harness that gates on regression-from-baseline
(not absolute bars, not string equality), with cassette infra for deterministic
offline CI (feeds P4).

---

## Outcome

A complete, unit-tested regression harness landed under `test/harness/`, plus a
20-fixture / 105-gold-fact corpus under `test/fixtures/gold/`, plus **live
Anthropic baselines + 20 recorded cassettes** produced by running the SHIPPED
fact extractor through the real `runtimeAwareComplete` path (CLI mode, key-free).

- **Fact-level precision/recall** via deterministic SEMANTIC matching (stemmed
  content-token overlap + alias/grounding-aware entity matching), never string
  equality.
- **Regression-from-baseline** with a fixed margin (default 0.10): a fixture
  regresses only if precision OR recall drops below its recorded baseline by more
  than the margin. A missing baseline is a NEW baseline to record, never a
  first-sight failure.
- **Accepted-delta policy** normalizes the three Phase-A single-pass deltas so
  characterized behavior never scores as a miss (structural, not post-hoc
  suppression).
- **Cassette infra** records the extractor's `ExtractedFact[]` per (provider,
  fixture) for offline replay — the Phase-4 PR-gate runs with zero external API
  calls.

**Live Anthropic baseline (CLI mode, sonnet-4-5): avg precision 0.625, avg
recall 0.963** across 20 fixtures. Offline replay gate: **0 regressions**.

Test total: **987 → 1015** (+28 harness unit tests). Five gates green.

---

## Gate evidence

| Gate | Status | Evidence |
|---|---|---|
| 20 fixtures + gold facts | ✓ | `test/fixtures/gold/01..20` — markdown, code, and pdf-text formats; 105 gold facts (`gold.test.ts` locks count + shape). |
| Fact-level P/R, not string equality | ✓ | `score.ts` semantic matcher; `score.test.ts` proves reworded statements match and verbatim is not required. |
| Regression-from-baseline + margin | ✓ | `regression.ts` (DEFAULT_MARGIN 0.1); `regression.test.ts` proves drop-beyond-margin flags, within-margin tolerated, no-baseline = new. |
| Accepted-delta not flagged | ✓ | `accepted-deltas.ts` (path strip, ISO strip, consolidated-entity aliases); `score.test.ts` + `harness.test.ts` prove the delta variant scores clean. |
| **Intentional-regression caught** | ✓ | `harness.test.ts` "CATCHES an intentional regression" — a degraded extraction (1/3 recall) against a recorded baseline flags. |
| Cassette record/replay | ✓ | `cassette.ts` + `cassette.test.ts` round-trip; 20 real cassettes recorded; `--mode replay` runs offline. |
| Baselines recorded (live) | ✓ | `test/fixtures/gold/baselines.json` — 20 Anthropic baselines from real extractor runs (CLI mode). |
| Offline replay gate | ✓ | `run-harness.ts --mode replay` → all OK, 0 regressions against recorded baselines. |
| `test` | ✓ | 1015 passed (100 files). |
| `lint` / `format:check` / `typecheck` / `build` | ✓ | eslint clean (covers `test/harness`); prettier clean; `tsc --noEmit` clean (src); tsup success. |

---

## Defects against canon

| Canon | Class | Firing | Resolution |
|---|---|---|---|
| `feedback_open_the_box_before_changing` | application | http-status-codes scored R=0.20 with 16 extracted facts; the live runner first failed with "claude native binary not installed". | Read the actual cassette (extractor output was excellent — a SCORER false-negative on numeric-keyed entities) and the actual error (`npx` prepends `node_modules/.bin`, so bare `claude` resolved to the wrong launcher). Fixed root causes (entity-compatibility model; pin absolute binary), not symptoms. |
| `feedback_structural_vs_theatrical` | application | Could have shipped the strict scorer and waved off low scores as "it's only relative." | Made the scorer genuinely reflect reality (stemming + principled entity-compatibility with conflict-rejection) so the gate is credible. avg recall 0.77 → 0.96 as false-negatives were removed — without breaking the wrong-entity guard. |
| `feedback_verify_before_assert` | application | Tempting to accept R=0.40 baselines as "honest extractor behavior." | Inspected cassettes (dna/tcp/stoicism) to confirm these were scorer strictness, not extractor misses, before changing anything. |
| `feedback_artifact_validation_gates` | application | A regression harness whose scorer floors true 100% extraction at 40% would mask real regressions. | The scorer now tracks true quality, so a real drop is detectable against a meaningful baseline rather than a noise floor. |
| `feedback_boil_the_ocean` | application | — | Full harness (scorer + regression + accepted-delta + cassette + orchestrator) + 20 fixtures + live baselines + 28 unit tests + offline replay demo. |

---

## Infrastructure state

- Branch `multi-llm-harness`; no push (one human-gated push at arc close).
- No deploy. Live extractions via CLI mode (claude binary, subscription, key-free).
- Recorded assets committed: `test/fixtures/gold/baselines.json`,
  `test/fixtures/gold/cassettes/anthropic/*.json` (20).

---

## Code landed

**Added — harness library (`test/harness/`):**
- `types.ts`, `score.ts` (semantic scorer + stemmer), `accepted-deltas.ts`,
  `regression.ts`, `cassette.ts`, `gold.ts` (loader), `harness.ts` (orchestrator),
  `run-harness.ts` (live/record + offline rescore/replay CLI).
- Tests: `score.test.ts`, `regression.test.ts`, `cassette.test.ts`,
  `harness.test.ts`, `gold.test.ts` (28 tests).

**Added — corpus (`test/fixtures/gold/`):**
- `01..20/` source + `gold.json` (105 gold facts).
- `baselines.json` (20 Anthropic baselines), `cassettes/anthropic/*.json` (20).

**Added:** `MULTI-LLM-HARNESS-PHASE-3.md` — this closure doc.

**Test totals:** 1015 (was 987; +28; no deletions).

---

## Outstanding with hard gates

### Phase 4: CI integration
- PR-gating suite on RECORDED CASSETTES (`--mode replay`, offline, deterministic).
- Key-gated live skip: non-Anthropic providers with no key/cassette report
  SKIPPED, never fail (already the harness behavior; CI wiring is P4).
- Scheduled weekly live run (non-PR-gating) for provider drift, recorded at the
  default sonnet tier (per F3's model-sensitivity finding).

### Non-Anthropic provider baselines (key/server-gated)
The harness runs ALL providers (provider loop + skip-on-no-cassette). This
session only Anthropic was extractable (CLI mode, key-free); OpenAI/Gemini need
API keys and Ollama needs a running local server (it was transiently up then
unreachable, CLI not on PATH). Their baselines/cassettes are recorded when creds
are present — flagged, not faked (Phase A/B precedent).

---

## Notes for review

- **Anthropic baselines were recorded via the CLI extraction path** (claude
  binary), i.e. `runtimeAwareComplete`'s CLI branch — NOT the `AnthropicProvider`
  Messages-API class. Both are the shipped single-pass extractor; the
  provider-class API path is key-gated. When `ANTHROPIC_API_KEY` is present,
  record an `anthropic` (API-mode) cassette set to baseline the provider class
  directly.
- **Precision ~0.62 is by design.** Gold sets are curated SUBSETS (4–6 facts);
  the extractor legitimately emits more (e.g. 16 for http-status-codes), so
  extra-but-valid facts depress precision. Relative gating is exactly why the
  directive chose regression-from-baseline over absolute bars.
- **Scorer is principled, not overfit.** The two improvements (conservative
  stemming; entity-compatibility with distinctive-token grounding + conflict
  rejection) are general rules; the wrong-entity guard test still passes. They
  were driven by real false-negatives, not by tuning to hit a number.
- **Ollama** is included via the provider loop as a local/self-host path only —
  it never touches the hosted credential model (credential heterogeneity is
  already handled daemon-side via `baseURL`, not `apiKey`).
- The harness lives under `test/` (repo convention: QA infra, not shipped daemon
  runtime). `tsc` excludes `test/` by repo config, so the harness is type-checked
  transitively by vitest execution and covered by eslint + prettier; its logic is
  unit-tested directly.
