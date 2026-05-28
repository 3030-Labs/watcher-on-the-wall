# URL-REFERENCE-INVENTORY — PASS-026 org migration (DriftVane → 3030-Labs)

**Generated:** 2026-05-28. **Scope:** every `DriftVane` / `driftvane`
reference across the 4 repos, classified by sweep-action. Raw source:
`grep -rniI driftvane` across each repo (excluding node_modules/.git/dist/
.next/build/coverage).

**Totals:** watcher-on-the-wall 59 · wotw-cloud 37 · wotw-verify 101 ·
homebrew-tap 11 = **208 references.**

---

## Reference CLASSES (the load-bearing distinction)

A naive `grep -i driftvane` conflates five different things. They do NOT
all migrate the same way:

| Class | String shape | Sweep action |
|---|---|---|
| **1. GitHub org** | `DriftVane/<repo>`, `github.com/DriftVane`, `raw.githubusercontent.com/DriftVane`, `owner: DriftVane`, `repository: DriftVane/…`, Go module `github.com/DriftVane/wotw-verify` | **SWEEP → 3030-Labs** (core of PASS-026; redirect-dependent) |
| **2. npm scope** | `@driftvane/wotw` (lowercase) | **DEFER → PASS-027.** Goal scopes package.json to repository/homepage/bugs, NOT `name`. npm scope decision (`@driftvane` vs `@3030labs`) is an explicit PASS-027 item. |
| **3. Company / legal identity** | `DriftVane LLC` (wotw-verify LICENSE), `DriftVane team` (email sigs), `DriftVane's Compliance tier` (marketing copy) | **CONFIRM w/ Justin** — "3030 Labs is the legal entity" suggests yes, but it's branding, not a GitHub redirect. |
| **4. Email / domain** | `security@driftvane.com`, `team@driftvane.com`, `release-bot@driftvane.com`, `wotw.driftvane.com` | **CONFIRM w/ Justin** — daemon SECURITY.md already uses `security@3030labs.io`; these likely → 3030labs.io, but they're DNS/email infra, not GitHub. |
| **5. Fly.io org** | `--org driftvane`, `FLY_ORG_SLUG=driftvane`, `ghcr.io/driftvane/wotw` | **CONFIRM w/ Justin** — Fly org is a SEPARATE infra migration. Changing the string without migrating the Fly org breaks deploys. Likely OUT of PASS-026 scope. |
| **6. Legacy / historical** | closure docs (PASS-022, PASS-023, FLY-MIGRATION-*), CHANGELOG era entries, LAUNCH-STATUS, BUILD-SUMMARY history, release-process v0.1.0 narrative | **KEEP** — historical record of the DriftVane era. Goal explicitly allows these. |

The hard-gate `grep "DriftVane"` is **case-sensitive PascalCase** — it
matches class 1/3/6 but NOT the lowercase npm scope (class 2) or most
class-4/5 (lowercase `driftvane`). This inventory treats class 1 as the
mandatory sweep and surfaces 2/3/4/5 for an explicit boundary decision.

---

## CLASS 1 — GitHub org refs (SWEEP → 3030-Labs)

### watcher-on-the-wall
- `package.json:62` repository.url → `github.com/DriftVane/watcher-on-the-wall.git`
- `package.json:65` bugs.url → `github.com/DriftVane/watcher-on-the-wall/issues`
- `CONTRIBUTING.md:18` clone URL
- `README.md:32` clone URL (gap-window block)
- `README.md:107` wotw-verify link
- `README.md:146` wotw-verify link (Links section)
- `src/wiki/templates/index.md:9` — **ships into user vaults** (scaffolded starter page)
- `docs/pack-format-daemon.md:5,238` wotw-verify links
- `.github/ISSUE_TEMPLATE/config.yml:4,13` security-advisories + docs URLs
- `.github/workflows/install-evidence.yml` — only the `@driftvane/wotw` npm refs (class 2); no class-1 org path here

### wotw-cloud
- `daemon-host/Dockerfile:11,23` clone URL + comment
- `fly/Dockerfile:5,55` clone URL + comment (`ghcr.io/driftvane/wotw` is class 5)
- `fly/README.md:36` token-scope comment
- `scripts/deploy.sh:20` token-scope comment
- `docs/compliance-pack-format.md:9` wotw-verify link
- `web/app/(marketing)/layout.tsx:29,87` GitHub links
- `web/app/(marketing)/pricing/page.tsx:72` GitHub link
- `.github/workflows/ci.yml:44` `repository: DriftVane/watcher-on-the-wall` (sync-gate checkout)

### wotw-verify (the heaviest — includes Go module path)
- `go.mod:1` **module path** `github.com/DriftVane/wotw-verify` → rewrites every internal import
- Internal imports (6 files): `internal/selftest/selftest.go:18,19`, `internal/provenance/chain.go:12`, `internal/fixturegen/fixturegen.go:25,26`, `internal/verify/verify.go:10,11,12`, `internal/verify/verify_test.go:8,9,10`, `cmd/wotw-verify/main.go:22,23,24`
- `.goreleaser.yaml:52` ldflags ToolVersion path; `:122` `owner: DriftVane`
- `cmd/wotw-verify/main.go:54` protocol URL
- `README.md:3,4,32,41,51,73` badges + brew tap + install URL + releases + go install
- `scripts/install.sh:25,28` `REPO=` + `PUBKEY_URL=`
- `homebrew/wotw-verify.rb:1,14,20,24,31,35` seed formula URLs
- `docs/verification-protocol.md:10,114` daemon-repo links
- `docs/threat-model.md:127,153` daemon kek-rotation link
- `.github/workflows/release.yaml:62,73` homebrew-tap refs (commented)

### homebrew-tap
- `README.md:1,3,8,15,19,26` tap name + brew tap + wotw-verify links
- `Formula/wotw-verify.rb:3,9,13,20,24` homepage + 4 release-download URLs

---

## CLASS 2 — npm scope `@driftvane/wotw` (DEFER → PASS-027)

watcher: `package.json:2` (`name`), `SECURITY.md:58`, `README.md:20,27,133`,
`CHANGELOG.md:3`, `LICENSE-NOTICES.md:58,135`, `src/telemetry/sink.ts:207`,
`src/utils/actionable-error.ts:178`, `docs/install-evidence/*` (3),
`.github/workflows/install-evidence.yml` (7 refs), `LAUNCH-PREP.md:6`.
wotw-cloud: `daemon-host/README.md:5`, `web/app/(marketing)/layout.tsx:97`
(npmjs.com/package link), `SD-1-DAEMON-SYNC-NOTES.md:102`
(`@driftvane/provenance-chain-hash`).

**Action:** leave as-is this pass. If PASS-027 keeps `@driftvane`, no
change ever. If it moves to `@3030labs`, that sweep rides with the npm
publish (one atomic scope change at publish time).

---

## CLASS 3 — company / legal identity (CONFIRM)

- wotw-verify `LICENSE:5` `Copyright 2026 DriftVane LLC`
- wotw-verify `README.md:198` `Copyright 2026 DriftVane LLC`
- wotw-verify `README.md:185,187`, `docs/threat-model.md:58,60,78,80,87,88,140,147-152` — "collude with DriftVane", "genuinely DriftVane's" (trust-model prose naming the signing entity)
- wotw-cloud `packages/shared/src/email.ts:94,126,148,214,255,287` `— The DriftVane team` (6 customer-facing email signatures)
- wotw-cloud marketing `trust-model/page.tsx:6,28,47,68,86`, `upgrade-client.tsx:92` — "DriftVane's Compliance tier", "DriftVane infrastructure", "trust DriftVane's opinion"

## CLASS 4 — email / domain (CONFIRM)

- wotw-verify `docs/threat-model.md:169` `security@driftvane.com`
- wotw-verify `.goreleaser.yaml:163` `release-bot@driftvane.com` (commented)
- wotw-cloud `packages/shared/src/email.ts:9` + `__tests__/*` `team@driftvane.com` (default-sender fallback)
- wotw-cloud `FLY-MIGRATION-PASS-008.md:195` `wotw.driftvane.com` (historical — likely class 6)

## CLASS 5 — Fly.io org / registry (CONFIRM — separate infra migration)

- wotw-cloud `fly/Dockerfile:8` `ghcr.io/driftvane/wotw`
- wotw-cloud `web/scripts/pass-017-phase-3-smoke-provision.ts:20`, `pass-020-smoke-provision.ts:22` `FLY_ORG_SLUG e.g. "driftvane"`
- watcher `FLY-MIGRATION-PASS-001.md:24,125` `--org driftvane` (historical — class 6)

---

## CLASS 6 — legacy / historical (KEEP, do not sweep)

These record the DriftVane era and must stay accurate to history:
- watcher: `PASS-023-DAEMON-PUBLIC-READINESS.md` (12), `PASS-023-DOGFOOD-FINDINGS.md` (6), `BUILD-SUMMARY.md` (2), `CHANGELOG.md:85` (deferral note), `FLY-MIGRATION-PASS-001.md` (2), `LAUNCH-PREP.md`
- wotw-cloud: `LAUNCH-STATUS.md` (2), `FLY-MIGRATION-PASS-008.md`, `SD-1-DAEMON-SYNC-NOTES.md`
- wotw-verify: `PASS-022-WOTW-VERIFY.md` (23 — entire closure doc), `docs/release-process.md` v0.1.0 narrative refs (the procedural ones that name the live repo → those are class 1 and DO sweep; the historical "how v0.1.0 was cut" → keep)

**Nuance:** `docs/release-process.md` (23 refs) is mixed — the *procedural*
URLs a future release operator will use (`--repo DriftVane/wotw-verify`,
clone URLs, the cosign-pubkey URL) are LIVE (class 1, sweep); the
*narrative* "how v0.1.0 was cut under DriftVane" is historical (keep).
This file gets a careful line-by-line pass, not a blanket replace.

---

## Sweep mechanics (pre-written, Part A.2 — applied only post-transfer)

- **Bulk string replace** `DriftVane` → `3030-Labs` and
  `github.com/DriftVane` → `github.com/3030-Labs` across class-1 files,
  EXCLUDING class-6 historical docs (PASS-*, FLY-MIGRATION-*,
  LAUNCH-STATUS, BUILD-SUMMARY, CHANGELOG history lines).
- **Go module path** (`go.mod` + 6 import files + `.goreleaser` ldflags):
  `github.com/DriftVane/wotw-verify` → `github.com/3030-Labs/wotw-verify`.
  Note: `3030-Labs` has a hyphen — valid in a Go module path. Verify
  `go build ./...` + `go test ./...` after.
- **git remotes** (all 3 local repos): `git remote set-url origin
  git@github.com:3030-Labs/<repo>.git` post-transfer.
- **homebrew-tap**: README + formula URLs; `brew tap DriftVane/tap` →
  `brew tap 3030-Labs/tap`.

## RESOLVED BOUNDARY (2026-05-28, Justin)

- **Class 1 (GitHub org):** SWEEP `DriftVane` → `3030-Labs` (URL slug) /
  `3030 Labs` (prose). Includes the Go module path.
- **Class 2 (npm scope):** DEFER to PASS-027 — but the value is DECIDED:
  `@driftvane/wotw` → `@3030labs/wotw`, executed atomically at publish.
  Leave `@driftvane/wotw` in the tree this pass. PASS-027 entry criteria:
  (a) claim `@3030labs` npm org before publish, (b) publish
  `@3030labs/wotw@0.8.4`, (c) `@driftvane/wotw` is never published.
- **Class 3 (company / legal identity):** SWEEP — **DriftVane is fully
  retired as a brand.** `DriftVane LLC` → `3030 Labs LLC`; `The DriftVane
  team` → `The 3030 Labs team`; `DriftVane's Compliance tier` → `3030 Labs'
  Compliance tier` (or `wotw Compliance tier` where the product brand reads
  better — my judgment per file). Product name stays `wotw`; only the
  builder/owner identity changes. Threat-model prose ("collude with
  DriftVane", "genuinely DriftVane's") → 3030 Labs.
- **Class 4 (email/domain):** SWEEP to 3030labs.io WITH inbox gate.
  `security@driftvane.com` → `security@3030labs.io` (canonical since
  PASS-023, safe). `release-bot@driftvane.com` → `release-bot@3030labs.io`
  but it's in a COMMENTED `.goreleaser` stanza — flag as pending-inbox
  before the stanza is uncommented. `team@driftvane.com` is an
  **illustrative bad-example in an email.ts code comment + its test** (not
  a live inbox) → `team@example.com` (RFC-2606 reserved placeholder) so
  the example doesn't name the real company domain as "the misconfigured
  one." `wotw.driftvane.com` is historical (class 6, keep).
- **Class 5 (Fly.io org):** KEEP — separate infra migration. `--org
  driftvane`, `FLY_ORG_SLUG=driftvane`, `ghcr.io/driftvane/wotw` all stay.
  Track a Fly-org migration as its own future pass.
- **Class 6 (legacy/historical):** KEEP unchanged.

**Post-sweep gate:** `grep -rn "DriftVane" <each repo>` (case-sensitive,
excluding class-6 docs) = 0. Lowercase `driftvane` survives only in
class-2 npm scope (deferred), class-5 Fly refs (kept), and class-6 history.
