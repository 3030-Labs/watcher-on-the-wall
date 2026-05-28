# PASS-026 — GitHub Org Migration (DriftVane → 3030-Labs) Closure

**Status:** ✅ CLOSED. All 4 repos migrated + swept + CI re-verified;
wotw-verify v0.1.1 cut, cosign-signed, published, trust-chain proven; live
`brew install` --self-test 5/5 confirmed on darwin (operator's Mac).
**Date:** 2026-05-28. (Sole residual: wotw-cloud's pre-existing typecheck,
ruled out-of-scope — see finding.)
**Out of scope (→ PASS-027):** npm publish v0.8.4, canonical npm-path
validation. **Out of scope (separate pass):** Fly.io org migration,
wotw-cloud Supabase-typing fix.

DriftVane is retired as a brand. 3030 Labs is the legal entity + tech
umbrella; the product name stays `wotw`. The cosign signing key is
**unchanged** — only URLs + identity moved.

---

## Part A — inventory + pre-written sweep

- `URL-REFERENCE-INVENTORY.md` — 208 references across 4 repos, classified
  into 6 classes (GitHub org / npm scope / company identity / email-domain
  / Fly org / legacy-historical). Boundary decisions recorded there.
- Pre-written sweep staged at `/tmp/pass-026-sweep.sh` + a 6-item
  manual-edit checklist. **Key design:** case-sensitive `DriftVane`
  (PascalCase) auto-protects lowercase `@driftvane` (npm scope, deferred)
  and `driftvane` (Fly org, kept).

## Part B — transfers (all 4, human-authorized gates)

| Repo | Visibility | Redirect | Notes |
|---|---|---|---|
| watcher-on-the-wall | public | 301 ✓ | 0 secrets (none to migrate); CI + install-evidence workflows survived |
| wotw-cloud | private | gh-auth resolves ✓ | 0 webhooks/keys/secrets — **no in-repo deploy automation broke**; Vercel/Fly GitHub-App links are org-scoped + need dashboard re-link (cleanup, not transfer-broken) |
| wotw-verify | public | 301 ✓ | **COSIGN_PRIVATE_KEY + COSIGN_PASSWORD survived** ✓; ci + release workflows survived |
| homebrew-tap | public | 301 ✓ | simplest; formula bumped to v0.1.1 in Part D |

Order: watcher (canary) → wotw-cloud → wotw-verify → homebrew-tap, one at
a time with verification between each. Sync gates went cross-org during
the window — confirmed expected-transient, reconciled once both moved +
swept (they compare local sibling content + the swept org-qualified CI
checkout paths).

## Part C — URL sweep (all 4 repos)

**Hard gate met: 0 non-legacy DriftVane hits across all 4 repos.**

| Repo | Commit(s) | Verification |
|---|---|---|
| watcher-on-the-wall | `745d840` | 935 tests, 7 gates green, chain-hash + llm-types sync byte-identical |
| wotw-verify | `5b8ac2b`, `7c5d944` | `go build`/`go test` green under new module path `github.com/3030-Labs/wotw-verify` |
| wotw-cloud | `d1f6c95`, `7e104b6` | lint + 545 tests + both sync gates green; **typecheck pre-existing-red (see finding)** |
| homebrew-tap | `6395c39`, `0bee314` | formula → v0.1.1 |

Preserved as decided: `@driftvane/wotw` npm scope (deferred), lowercase
Fly refs (`ghcr.io/driftvane`, `FLY_ORG_SLUG=driftvane`), historical
closure docs (PASS-022/023, FLY-MIGRATION, LAUNCH-*, BUILD-SUMMARY,
CHANGELOG history). Company identity fully swept: LICENSE → 3030 Labs LLC,
email sigs → The 3030 Labs team, marketing → 3030 Labs' Compliance tier,
`security@driftvane.com` → `security@3030labs.io`, illustrative
`team@driftvane.com` → `team@example.com`.

### Findings

- **wotw-cloud typecheck: 15 PRE-EXISTING errors** in
  `scripts/pass-025-smoke-dual-compliance.ts` (Supabase client generic-type
  drift). Proven pre-existing: committed-tree count (15) == with-sweep
  count (15); zero swept files in the errors; it's a smoke script. The
  "wotw-cloud 5 gates green" hard gate is therefore 4/5 — migration-critical
  gates (sync byte-identity ×2, tests 545, lint) all green; typecheck red
  on an unrelated Supabase issue. **Tracked as a separate future wotw-cloud
  /goal**, not fixed here (org migration ≠ Supabase typing).
- **Sweep bug caught + fixed pre-tag:** the prose rule `DriftVane` → `3030
  Labs` (space) mangled GoReleaser's `release.github.owner: DriftVane` into
  `owner: 3030 Labs` (space) — but that field needs the org SLUG `3030-Labs`
  (hyphen) or the release publish fails. Caught in the pre-tag goreleaser
  audit, fixed in `7c5d944`. Lesson: after a PascalCase→spaced-prose sweep,
  audit slug/owner/path contexts for space-vs-hyphen.
- **Stray `.claude/scheduled_tasks.lock`** swept into wotw-cloud by
  `git add -A`; removed + `.claude/` gitignored (`7e104b6`).

## Part D — wotw-verify v0.1.1 re-cut

- Tag `v0.1.1` pushed → release workflow run `26605824058` **completed
  success**. GoReleaser built 5 platforms, cosign-signed all artifacts +
  checksums, published to `3030-Labs/wotw-verify` releases (12 assets).
- **Trust-chain proof (key bridges the org move):** under the unchanged
  `cosign.pub` (SHA-256 `64bdbebf…`), BOTH verify:
  - v0.1.1 (post-migration) `linux_x86_64.tar.gz` → **Verified OK**
  - v0.1.0 (pre-migration, DriftVane-era) `linux_x86_64.tar.gz` → **Verified OK**
  - checksums file signature → **Verified OK**
- **v0.1.1 binary --self-test: 5/5 green** (linux x86_64): valid_g5,
  tampered_content, tampered_hmac, mid_chain_rotation, pre_g5_backward_compat.
- **Homebrew formula** (`3030-Labs/homebrew-tap`) bumped to v0.1.1 with the
  4 real SHA-256s; `sha256sum -c` confirmed the linux_x86_64 hash matches
  the published artifact.
- **v0.1.0 left untouched** as the historical DriftVane-era release (not
  deleted, not modified) — its signatures still verify under the same key.

- **Live Homebrew install --self-test: ✅ confirmed on darwin** (operator's
  Mac, 2026-05-28): `brew tap 3030-Labs/tap` → `brew install wotw-verify`
  (brew reported "Formula wotw-verify (0.1.1) Verified" — re-checked the
  SHA-256 against the formula, matched) → `wotw-verify --version` = 0.1.1
  → `wotw-verify --self-test` = 5/5 green. Full darwin tap→install→self-test
  path works end-to-end.

---

## Hard-gate ledger

| Gate | State |
|---|---|
| All 4 repos transferred + redirects active | ✅ |
| grep "DriftVane" = 0 non-legacy hits, all 4 repos | ✅ |
| wotw-cloud 5 gates green post-sweep | 🟡 4/5 — typecheck pre-existing-red (Supabase smoke script, unrelated; documented) |
| watcher-on-the-wall 7 gates green post-sweep | ✅ (935 tests) |
| chain-hash-sync + llm-types-sync byte-identical | ✅ (both directions) |
| wotw-verify v0.1.1 cosign-signed + published + Homebrew --self-test 5/5 | ✅ cosign+publish+trust-chain+binary-self-test + LIVE darwin `brew install` --self-test 5/5 (operator's Mac) |
| npm package NOT published | ✅ (deferred to PASS-027) |

---

## DEFERRED TO PASS-027 (npm publish)

Recorded from PASS-026's boundary decisions:
- **npm scope DECIDED:** `@driftvane/wotw` → `@3030labs/wotw`. Left in the
  tree this pass (lowercase, untouched by the sweep). PASS-027 entry
  criteria: (a) claim the `@3030labs` org on npm before publish, (b) publish
  `@3030labs/wotw@0.8.4`, (c) `@driftvane/wotw` is never published under
  that name, (d) sweep the lowercase `@driftvane/wotw` refs atomically with
  the publish (package.json `name`, README/docs install lines, workflow npm
  refs, src comments).
- Canonical npm-path validation on clean macOS/Linux/Windows (PASS-023
  Bucket A) rides PASS-027 once the package is live.

## Separate future passes (not PASS-027)

- **Fly.io org migration** — `driftvane` Fly org slug + `ghcr.io/driftvane`
  registry refs were deliberately KEPT (changing the string without
  migrating the Fly org breaks deploys). Own pass when the Fly org moves.
- **wotw-cloud Supabase typing fix** — the 15 pre-existing typecheck errors.
- **Vercel/Fly GitHub-App re-link** on the 3030-Labs org (dashboard work).
