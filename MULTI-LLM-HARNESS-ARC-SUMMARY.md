# Multi-LLM Verify-and-Harness Arc — Summary

**Date:** 2026-05-31
**Branch:** `multi-llm-harness` (off `c95bfa2`, FEATURE-PASS-011)
**Status:** P1–P4 complete, all gates green. **NOT pushed — awaiting human
authorization** (one human-gated push at arc close, per cadence).

This arc verified the SHIPPED single-pass LLMProvider abstraction and built a
standing gold-fact regression harness + CI. Single-pass stayed LOCKED throughout
— no agent-loop reintroduction; the no-agent-SDK-import invariant test is green.

---

## Per-phase status

| Phase | Outcome | Commit | Gate |
|---|---|---|---|
| **P1** Verify shipped + TRUE parity | Shipped abstraction confirmed (complete()-altitude interface, 7 callers via `runtimeAwareComplete`, invariant test green). Added a permanent config-chain integration guard (closes Phase A's named gap). Real CLI-mode live-fixture ingestion through the genuine `loadConfig` chain: 6 pages, provenance, zero dead-letters. | `27248bf` | ✓ 987 green, live parity clean |
| **P2** Finish fixtures F2/F3/F5 | F1–F5 all pass parity on the shipped single-pass pipeline. F3 (edit-existing-page) characterized as model-tier-sensitive: passes on default sonnet, haiku too weak — isolated via controlled diagnosis, not a false break. | `3237a69` | ✓ F1–F5 parity, 5 gates |
| **P3** Gold-fact harness | The real new code: semantic fact-level P/R scorer, regression-from-baseline gate, accepted-delta normalization, cassette infra, 20-fixture/105-fact corpus, live Anthropic baselines (avg P=0.625 R=0.963), 28 unit tests. | `b45cec7` | ✓ 1015 green, replay 0 regressions |
| **P4** CI integration | Offline cassette PR-gate (vitest, in `pnpm test`) — proven to block on a degraded cassette and to skip gracefully on absent keys. Scheduled weekly live drift workflow (key-gated, non-PR-gating). | _this commit_ | ✓ 1019 green, gate blocks-on-regression proven |

---

## Live-fixture parity result (the load-bearing P1 gate)

A real `wotw` daemon, configured via the genuine `loadConfig → mergeConfig →
applyEnvOverrides → validateConfig` chain (not a constructed config), ingested a
fixture in CLI mode (key-free) and produced **6 wiki pages + a content-addressed
provenance `ingest` record, zero dead-letters, single-pass (`maxTurns: 1`)**. The
Phase-A Zod-strip class is now guarded by a permanent cosmiconfig integration
test. The single-pass architecture is intact and exercised end-to-end.

---

## Findings

1. **Most of ML1/ML2 was already shipped (Phase 10/10b/A)** under the locked
   single-pass design — this arc correctly became verify-and-harness, not
   rebuild. (Resolved before authoring; see the pre-arc read.)
2. **F3 edit-existing-page is model-tier-sensitive** — fresh ingestion (F1/F2/F5)
   is robust across tiers; the edit/merge path needs the default sonnet tier. The
   practical residue of multi-turn → single-pass. Drives P3's accepted-delta
   policy and P4's cassette tier.
3. **Scorer false-negatives vs extractor misses** — two principled scorer
   improvements (stemming; entity-compatibility with distinctive-token grounding
   + conflict-rejection) lifted measured recall 0.77 → 0.96 to reflect the
   extractor's true quality, without weakening the wrong-entity guard.
4. **Keys absent all session (Phase A/B precedent)** — every live step ran
   key-free (CLI mode / local). Non-Anthropic and API-mode-Anthropic baselines
   remain key/server-gated; the harness skips them cleanly. Flagged, not faked.
5. **Minor, out-of-scope:** `dist/index.js` (library bundle) throws on a
   `require('../../package.json')` when run directly; the CLI bin is correct.
   Noted for a future packaging pass.

---

## Test growth

985 (HEAD `c95bfa2`) → **1019** (+34: 2 config-chain guards in P1, 28 harness
unit tests in P3, 4 replay-gate assertions in P4). Zero deletions.

---

## Out of scope (separate wotw-cloud arc)

ML3 — cloud Phase C/D: `wikis.llm_provider` Supabase migration, tenant-
orchestrator per-provider secret selection, `/settings/api-keys` UI, fact-
extraction UI toggle. The byte-identical `src/llm/types-vendored.ts` copy
contract with wotw-cloud was respected (no interface change this arc).

---

## Next action (human-gated)

Four per-phase commits sit on `multi-llm-harness`, unpushed:
`27248bf → 3237a69 → b45cec7 → <P4>`. Per the irreversible-actions-are-human-
gated canon, the single push of this branch awaits explicit authorization.
