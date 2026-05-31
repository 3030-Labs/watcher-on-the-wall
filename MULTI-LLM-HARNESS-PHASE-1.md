# Multi-LLM Verify-and-Harness Arc — PHASE 1: Verify shipped abstraction + TRUE parity gate

**Date:** 2026-05-31
**Branch:** `multi-llm-harness` (off `c95bfa2`, FEATURE-PASS-011)
**Arc:** verify the shipped single-pass LLMProvider abstraction; build the standing gold-fact regression harness + CI. Single-pass is LOCKED — no agent-loop reintroduction.

---

## Outcome

Phase 1 proves the shipped single-pass provider abstraction is intact and exercised end-to-end through the **real production config chain**, with the parity gate the mocked 985-test suite structurally cannot provide.

Two artifacts landed:

1. **Permanent config-chain integration guard** (`test/unit/config.test.ts`, +2 tests). Phase A's deepest finding was a Zod-schema gap that stripped the `llm` block and crashed `selectProvider` on every pre-Phase-10 wiki — invisible to the test suite because the regression test calls `validateConfig` on a *directly-constructed* config, never driving the `file → cosmiconfig → mergeConfig → applyEnvOverrides → validateConfig` chain. Phase A's own "notes for review" flagged the gap: *"The integration test would need to load an actual wotw.config.yaml via cosmiconfig to exercise the bug."* This phase closes it.

2. **Real CLI-mode live-fixture ingestion** through the genuine `loadConfig` chain. A hand-built vault (`wotw.yaml` + `raw/` + `wiki/`) was ingested by the actual `wotw` daemon binary in CLI mode (claude binary, subscription, **zero API key**). Result: **6 wiki pages written, batch complete, provenance `ingest` record appended, zero dead-letters, no config-chain crash.**

Single-pass confirmed live: the ingestion log shows `spawning claude CLI … maxTurns: 1`. The no-agent-SDK-import invariant test is present and green within the suite.

**Test total: 985 → 987** (+2 config-chain guards; zero deletions). All five gates green.

---

## Multi-row gate evidence

| Gate | Class | Status | Evidence |
|---|---|---|---|
| HEAD precondition | mechanical | ✓ | `c95bfa2` confirmed; working tree clean (only untracked `SESSION-HANDOFF-2026-05-30.md`). |
| 985 baseline green | functional | ✓ | `vitest run` → 985 passed (95 files), exit 0, before any change. |
| Interface is `complete()`-altitude | structural | ✓ | `src/llm/types-vendored.ts:122` — `complete(prompt, options) → Promise<string>`; design note lines 29-31: *"Multi-turn agent loops … deliberately not reproduced here."* |
| 7 callers via `runtimeAwareComplete` | structural | ✓ | `compounding/engine.ts`, `facts/extractor.ts`, `ingestion/queue.ts`, `server/query-engine.ts`, `server/query-expansion.ts`, `wiki/heal-handlers.ts`, `wiki/vocabulary-enricher.ts`. |
| Providers present | structural | ✓ | `src/llm/providers/{anthropic,openai,gemini,ollama}.ts` — real implementations (153-189 LOC each, real pricing tables). |
| no-agent-SDK-import invariant | structural | ✓ | `test/unit/llm/anthropic-provider.test.ts:338-356` greps provider source; asserts no `@anthropic-ai/claude-agent-sdk` / `claude-code` import. Green in suite. |
| Config-chain guard added | mechanical | ✓ | `test/unit/config.test.ts` +2: explicit `llm` block survives real `loadConfig`; pre-Phase-10 (no `llm` block) resolves to `anthropic` default. |
| **TRUE parity — live-fixture ingestion through real config chain** | **behavioral** | **✓** | Daemon booted via real `loadConfig` (port 8799 from YAML, CLI mode resolved). `raw/tardigrades.md` → `batch complete, pagesWritten: 6`; provenance `ingest` seq:1 with `source_hashes`/`prompt_hash`/`response_hash`/`model_id: claude-haiku-4-5`; **zero dead-letters**. |
| `pnpm typecheck` | mechanical | ✓ | `tsc --noEmit` exit 0. |
| `pnpm lint` | mechanical | ✓ | eslint clean. |
| `pnpm format:check` | mechanical | ✓ | prettier clean. |
| `pnpm test` (post-change) | functional | ✓ | 987 passed (95 files), exit 0. |
| `pnpm build` | mechanical | ✓ | tsup ESM + DTS success. |

---

## Defects against canon

| Canon | Class | Firing | Resolution |
|---|---|---|---|
| `feedback_artifact_validation_gates` | application | The 985 mocked suite passes while never exercising the file-loaded-config path — exactly the proxy-gate Phase A warned about. | TRUE parity gate validates the real artifact: a config-discovered-via-cosmiconfig daemon producing real wiki pages + provenance. Mechanical gate (tests green) is necessary; functional gate (real config → real ingestion) is now also held. |
| `feedback_verify_before_assert` | application | "Shipped abstraction intact" must mean verified, not assumed. | Each claim grounded at file:line; the config-chain guard + live run prove the consumption path, not just the source. |
| `feedback_open_the_box_before_changing` | application | First daemon start crashed on `Cannot find module '../../package.json'`. | Observed the actual error rather than guessing — it was the wrong entrypoint (`dist/index.js` library bundle, not the `dist/cli/index.js` bin). Re-ran correct bin; booted clean. No code "fix" applied to a non-bug. |
| `feedback_boil_the_ocean` | application | Could have stopped at "985 green, looks fine." | Added the permanent config-chain integration test (closing Phase A's named gap) AND ran a real end-to-end ingestion, not a mock. |

---

## Infrastructure state

- Branch `multi-llm-harness` off `c95bfa2`. No commits yet pushed (per cadence: one human-gated push at arc close).
- No deploy. Local-only verification.
- Live vault: `/tmp/wotw-p1/` (ephemeral, CLI mode, port 8799). Daemon started and stopped cleanly (PID 6932 → "Daemon stopped").

---

## Code landed

**Modified:**
- `test/unit/config.test.ts` — +2 config-chain integration guards (explicit-`llm`-block survival; no-`llm`-block → anthropic default), both driving the real `loadConfig(dir)` cosmiconfig chain.

**Added:**
- `MULTI-LLM-HARNESS-PHASE-1.md` — this closure doc.

**Test totals:** 987 (was 985; +2; no deletions).

---

## Outstanding with hard gates

### Phase 2: finish parity fixtures F2/F3/F5
**Gate:** F1–F5 all pass parity; five gates green; PHASE-2 closure. Only F1 (single-source) verified to date (Phase A). **STOP** if a fixture exposes a parity break in shipped providers.

### Phase 3: gold-fact regression harness (the real new code)
**Gate:** 20 fixtures + per-fixture gold facts; fact-level precision/recall (not string-equality); regression-from-baseline semantics; accepted-delta policy; cassette infra; intentional-regression caught.

### Phase 4: CI integration
**Gate:** cassette PR-gate blocks on regression; key-gated live skip graceful; scheduled weekly live run valid.

---

## Notes for review

- **Keys absent this session (Phase A/B precedent).** `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`GOOGLE_API_KEY` all unset; Ollama was transiently reachable then refused (CLI not on PATH). The live gate therefore ran in **CLI mode** (key-free, subscription). Consequence: the live LLM call did **not** traverse the API-mode `selectProvider → Provider` branch — that branch is where Phase A's crash lived. It is covered key-free by the new config-chain integration test, which proves the exact field Phase A stripped (`config.llm.provider`) survives the real load chain. A live API-mode ingestion (the provider classes making a real HTTP call) remains key-gated and is the right place to assert it in P3/P4 with cassettes; flagged, not faked.
- **Phase-A hallucinated-date delta did NOT recur.** The generated page has `created: '2026-05-31'` (today's real date), not a plausible-but-wrong year. Either the prompt template was anchored since Phase A or it is haiku-specific. Not over-claimed — P3's accepted-delta policy will characterize this properly across providers.
- **Minor packaging finding (out of scope):** `dist/index.js` (the library bundle, `main`) executes `require('../../package.json')` at runtime and throws `MODULE_NOT_FOUND` when invoked directly from the repo. The CLI bin (`dist/cli/index.js`) resolves correctly. Noted for a future packaging pass; does not affect installed-binary users or this arc.
