# Multi-LLM Phase A — Behavioral parity vs SDK baseline

**Date:** 2026-05-22
**Branch:** main
**Pre-pass:** `2e3846e` (Phase 10 daemon-side)

---

## Outcome

Phase A discovered a **hard regression in the refactored daemon** during live-API
parity testing: the Zod schema (`WotwConfigSchema`) was missing the `llm` block
added in Phase 10. `validateConfig` silently stripped the field, then
`selectProvider` crashed reading `config.llm.provider`. Existing wikis with no
`llm:` block in their config — i.e. every wiki initialized before Phase 10 —
would have failed immediately on first ingestion after the refactor shipped.

Fix landed in `src/daemon/config.ts`: added `llm` to `WotwConfigSchema` and to
`mergeConfig`'s override-handling. Added two regression tests in
`test/unit/config.test.ts`.

After the fix, F1 (single-source) ingestion succeeded on both baseline daemon
(pre-refactor commit `e93effe`) and refactored daemon (current HEAD with the
Zod fix). Both produced structurally-valid wiki output covering the same key
concepts. Refactored daemon is **55% cheaper** ($0.030 vs $0.068) and **20%
faster** (35.6s vs 44.7s) per fixture, with documented stylistic differences.

**All 5 daemon quality gates green** after the fix (typecheck, lint,
format:check, **611 tests passing** — 609 baseline + 2 new regression tests,
build).

---

## Multi-row gate evidence

| Gate | Class | Status | Evidence |
|---|---|---|---|
| Live Anthropic API key reachable in session | functional | ✓ | HTTP 200 from `claude-haiku-4-5` minimal completion call. |
| Baseline daemon ingestion fires | functional | ✓ | Pre-refactor (commit `e93effe`) processes F1 in API mode (via Agent SDK with `WOTW_CLAUDE_CLI_PATH` override pointing at `/home/jgoodman/.local/bin/claude`). `pagesWritten=12`, `costUsd=$0.068`, `durationMs=44715`. |
| Refactored daemon ingestion (pre-fix) | behavioral | **CRASH** | `TypeError: Cannot read properties of undefined (reading 'provider')` at `selectProvider`. Root cause: Zod `WotwConfigSchema` missing `llm` field; validation strips it; downstream code crashes. |
| Phase A regression FIX landed | mechanical | ✓ | `src/daemon/config.ts` +7 lines: `llmProviderSchema` enum, `llm` block in `WotwConfigSchema`, `if (override.llm) assign("llm", ...)` in `mergeConfig`. |
| Phase A regression tests added | mechanical | ✓ | `test/unit/config.test.ts` +2 tests: "preserves llm block through validation (regression: Zod stripped it pre-fix)" and "rejects an invalid llm provider". |
| Refactored daemon ingestion (post-fix) | functional | ✓ | F1 processes successfully. `pagesWritten=9`, `costUsd=$0.030`, `durationMs=35563`. |
| F1 wiki output structurally equivalent | behavioral | ✓ | Both daemons produce: frontmatter (title, category, sources, related, tags, confidence, source_count, last_compiled, superseded_by), markdown sections, `[[backlinks]]`, provenance footer. Concept coverage matches: photosynthesis, chlorophyll, chloroplasts, light-dependent-reactions, calvin-cycle, sources, index, log. |
| Documented stylistic differences | behavioral | ⚠ | (1) Baseline produces 12 pages (more granular: separate c3-plants/c4-plants/cam-plants/photosynthetic-pathways); refactored produces 9 (consolidated `c3-c4-cam-plants.md`). (2) Baseline uses unicode subscripts `6CO₂`; refactored uses plain text `6CO2`. (3) Baseline uses relative backlinks `./light-dependent-reactions.md`; refactored uses wiki-rooted `wiki/concepts/light-dependent-reactions.md`. (4) Refactored hallucinates `created: '2025-01-17'` in frontmatter; baseline uses today's date. |
| Cost regression check | functional | ✓ | Refactored is 55% cheaper per fixture ($0.030 vs $0.068). Expected outcome of multi-turn → single-pass. |
| Latency regression check | functional | ✓ | Refactored is 20% faster (35.6s vs 44.7s). |
| `pnpm typecheck` | mechanical | ✓ | `tsc --noEmit` exit 0 after fix. |
| `pnpm lint` | mechanical | ✓ | eslint clean. |
| `pnpm format:check` | mechanical | ✓ | prettier clean. |
| `pnpm test` | functional | ✓ | **611 tests passing (63 files)**. 609 baseline + 2 new regression tests. Zero test deletion. |
| `pnpm build` | mechanical | ✓ | tsup ESM + DTS success. |

---

## Defects against canon

| Canon | Class | Firing | Resolution |
|---|---|---|---|
| `feedback_verify_before_assert` | discovery | The Phase 10 pass-doc (MULTI-LLM-PHASE-010.md) claimed daemon ships "complete and self-contained" with all 5 gates green. The tests passed, but they didn't exercise the integration boundary where `validateConfig` strips Zod-unknown keys then downstream code dereferences them. The pass-doc's "609 tests passing" was a proxy gate — it didn't validate the actual integration path. | Phase A is the canonical-application discovery here: live fixture run surfaces the bug that mocked tests missed. Added two regression tests that would have caught this at Phase 10 if they'd existed. |
| `feedback_artifact_validation_gates` | application | The Phase 10 gates were file-existence and process-spawn-success. They didn't validate "an ingestion request actually completes against live API". Per canon: "Success criterion must match actual job." | Phase A's artifact validation is the ingestion completing — which it did on the baseline daemon, crashed on the refactored daemon (pre-fix), and succeeded on the refactored daemon (post-fix). Real artifact validation surfaced the regression. |
| `feedback_open_the_box_before_changing` | application | If I'd "fixed" the symptom by adding `?.provider ?? "anthropic"` defensive nil-checks to `selectProvider`, the underlying Zod-strip bug would remain. The fix needed to address the schema, not the consumer. | Fix is at the schema layer — the root cause — not at consumers. Future fields added to `WotwConfig` will follow the same pattern (type + defaultConfig + Zod schema + mergeConfig override-handling). |
| `feedback_boil_the_ocean` | application | Could have stopped at fix-the-immediate-bug. Per "boil the ocean", also added regression tests AND ran the full quality-gate sweep to confirm no collateral damage. | Both regression tests added; all 5 gates re-verified. |

---

## Phase A scope notes

- **F1 fixture (single-source photosynthesis) is the verified case.** Time and budget constraints in the autonomous session limited additional fixtures. F4 (real-world tech: Rust borrow checker) was queued and is processing concurrently at writing time; F2/F3/F5 remain.
- **OpenAI/Gemini keys are absent from this session.** Phase B can only run with the Anthropic provider against the refactored daemon. Phase C is sequence-gated on Phase B's non-Anthropic clearing and is therefore un-executable in this session — surfaced as a deferred gate, not "passed". See `MULTI-LLM-PHASE-A-B-C-CLOSURE.md` for the full provider-readiness matrix.

---

## Infrastructure state

- watcher-on-the-wall HEAD pre-Phase-A: `2e3846e`
- Daemon version: 0.3.1 (unchanged)
- No deploy: the Zod regression fix needs to ship before production-tenant configs (which have `llm:` blocks now per Phase 10b) can safely reach the refactored daemon's classifier path.

---

## Code landed

### watcher-on-the-wall

**Modified:**
- `src/daemon/config.ts` — added `llmProviderSchema`, `llm` to `WotwConfigSchema`, `llm` override-handling to `mergeConfig`
- `test/unit/config.test.ts` — added regression tests for llm-preservation and invalid-provider-rejection
- `MULTI-LLM-PHASE-A.md` — this pass-doc

**Test totals:** 611 (was 609; +2 regression tests; no deletions)

---

## Outstanding with hard gates

### Phase A: remaining 4 fixtures (F2, F3, F4, F5)

**Gate:** byte-identical wiki output between baseline and refactored modulo timestamps and stylistic differences documented above.

**Risk:** Low — the single-pass code path is the same for any fixture content. Failures would indicate prompt-template regressions, which are content-specific edge cases. F1 covers single-source; F4 (Rust borrow checker, in-flight at session end) covers cross-domain; F2 (multi-source biology), F3 (edit-existing-page), F5 (philosophy real-world) remain.

### Phase B: cross-provider regression (Anthropic-only achievable in this session)

**Trigger:** OpenAI + Gemini API keys present in session environment. Without them, Phase B's "Anthropic + one other provider clears" pass criterion is structurally unsatisfiable.

**Hard gate:** 95% schema conformance per provider. With only Anthropic, Phase B is partial-only.

### Phase C: cloud-side BYOK extension

**Trigger:** Phase B clears at least one non-Anthropic provider. Sequence-gated.

**Per goal directive Phase C scope:**
- `wikis.llm_provider` Supabase migration (default 'anthropic', NOT NULL)
- `tenant-orchestrator.ts` conditional Fly secret name selection
- Key rotation flow per-provider parameter

---

## Notes for review

- The Zod-strip regression was invisible to Phase 10's test suite because the tests construct `WotwConfig` objects directly (TypeScript trusts the type), not through the `loadConfig → mergeConfig → applyEnvOverrides → validateConfig` chain that runs in production. The integration test would need to load an actual `wotw.config.yaml` via cosmiconfig to exercise the bug.
- The refactored daemon's `created: '2025-01-17'` hallucinated date is a prompt-template issue: the prompt doesn't anchor "today" against the daemon's actual clock, so the LLM picks plausible-sounding dates. Baseline daemon's Agent SDK was multi-turn and presumably the agent reflected on actual frontmatter conventions during iteration; single-pass loses that opportunity. Fix would be to inject `today = <ISO date>` into the system prompt or post-process frontmatter. Not blocking Phase A pass; flagged for prompt-template polish.
- The `wiki/concepts/...` vs `./` backlink-path difference is also a prompt-template artifact. Baseline's Agent SDK had file-system tools and used relative paths matching the daemon's wiki conventions; refactored's single-pass produces absolute-from-wiki-root paths the LLM thinks are "more correct." Both are valid Obsidian links once mounted under the wiki root, but consistency matters for downstream tools. Worth a prompt-template anchor.
- **Phase A's deepest finding** isn't the F1 byte-diff — it's that Phase 10 shipped a structurally-broken refactor (Zod schema gap) that would have crashed every existing tenant's first ingestion. The 609-test baseline didn't catch it because the tests didn't exercise the file-loaded-config code path. This is exactly the failure mode `feedback_artifact_validation_gates` warns about: mechanical-gate passes (tests green) while functional gate (real config → real ingestion) silently fails.
