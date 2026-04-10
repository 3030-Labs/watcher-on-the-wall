# Audit V2 — HIGH Finding Fix Pass

**Date:** 2026-04-09
**Scope:** `AUDIT-REPORT-V2.md` HIGH findings only (F-7, F-12, F-13).
**Outcome:** All 3 HIGH findings resolved. All 5 quality gates green.

---

## 1. Summary table

| ID   | Severity | Title                                         | Status  | Files touched |
|------|----------|-----------------------------------------------|---------|---------------|
| F-7  | HIGH     | Non-timing-safe legacy auth token comparison  | ✅ Fixed | `src/server/middleware.ts`, `test/unit/middleware.test.ts` |
| F-12 | HIGH     | `SECURITY.md` falsely claims tokens are hashed at rest | ✅ Fixed | `SECURITY.md` |
| F-13 | HIGH     | `BUILD-SUMMARY.md` inventory drift (Feature Pass 001) | ✅ Fixed | `BUILD-SUMMARY.md` |

Nothing outside the scope of these three findings was modified in production code. Only the three files listed plus this summary and the F-7 regression test were touched.

---

## 2. F-7 — Timing-safe legacy auth comparison

### Problem

`src/server/middleware.ts` (legacy single-token branch) previously used
`provided !== opts.authToken` — a string comparison whose execution time
varies with the position of the first differing byte. The multi-user
`TokenStore` documents why it can skip timing-safe comparison (`wotw_` +
64 hex chars, 256-bit entropy, enumerated via a `Map.has` lookup), but
the legacy branch accepts arbitrary operator-chosen strings that can be
short or low-entropy. A remote attacker with timing measurements could
extract the token one byte at a time.

### Fix

Added a module-private `safeEqual(a, b)` helper that:

1. Converts both inputs to `Buffer` via `Buffer.from(...)`.
2. If lengths differ, calls `timingSafeEqual(aBuf, aBuf)` as a dummy
   constant-time operation (so the false-return branch has the same
   approximate timing signature regardless of which input was longer)
   and returns `false`.
3. Otherwise calls `crypto.timingSafeEqual(aBuf, bBuf)`.

Legacy auth then becomes:

```ts
const provided = extractBearer(req) ?? "";
if (!safeEqual(provided, opts.authToken)) {
  // 401
}
```

Using `?? ""` guarantees the call site never passes `null` or
`undefined` to `safeEqual` — a missing or malformed header produces an
empty string that fails the length check in constant time.

### Regression test

Added `test/unit/middleware.test.ts::"legacy single-token auth still accepts the right token and rejects every wrong variant (F-7)"` which pins the accept/reject contract across six cases:

| Case                        | Auth header                        | Expected |
|-----------------------------|------------------------------------|----------|
| Exact match                 | `Bearer secret-operator-token`     | 200, `user: "default"` |
| Same length, wrong bytes    | `Bearer secret-operator-tokeX`     | 401 |
| Shorter prefix              | `Bearer secret-operator-toke`      | 401 |
| Longer extension            | `Bearer secret-operator-tokens`    | 401 |
| Empty bearer                | `Bearer `                          | 401 |
| Missing header              | (none)                             | 401 |

This test does **not** measure timing — a timing-oracle test is
inherently flaky in CI. It exists to lock down the accept/reject
contract so a future refactor of `safeEqual` cannot silently widen or
narrow the set of tokens that match.

### Files

- `src/server/middleware.ts` — imported `timingSafeEqual`, added
  `safeEqual()` helper, swapped the legacy comparison.
- `test/unit/middleware.test.ts` — added F-7 regression test
  (middleware suite: 13 → 14 tests).

---

## 3. F-12 — `SECURITY.md` false token-hashing claim

### Problem

The "Cryptographic details" section of `SECURITY.md` stated:

> **Token storage.** Multi-user tokens are stored as raw SHA-256
> digests in `workspaces_dir/tokens.json`. Plaintext tokens are never
> persisted.

This is false. `src/multi-user/token-store.ts::addUser` writes the
token verbatim via `atomicWrite` with mode `0o600` and `authenticate`
does `this.tokens.get(token) ?? null` on the plaintext value. There is
no hashing in the store at any point — the disk file holds the
bearer token in plaintext.

A reader trusting the docs would mis-classify a stolen `tokens.json`
as low-impact ("just digests, can't be replayed"), when in fact it is
a full credential compromise requiring `wotw user revoke` for every
affected user.

### Fix

Rewrote the bullet with the accurate description:

- Tokens are stored **verbatim** (not hashed) in
  `workspaces_dir/tokens.json`, mode `0600`.
- Tokens are 256-bit (`wotw_` + 64 hex chars) from `crypto.randomBytes`,
  so the on-disk file is the only credential material and must be
  treated as secret.
- Explicit operational guidance: backup tooling, container image
  layers, and log shipping must exclude `tokens.json`. A leak requires
  `wotw user revoke` per affected user.

### Additional correction (discovered in the sweep)

While checking SECURITY.md against the source, I noticed the
"Race conditions in atomic writes" bullet also drifted from the
implementation. It previously claimed that "the wiki store, cost log,
provenance chain, and dead-letter queue all use temp-file + rename
idioms." That is false — only the wiki store and the multi-user token
store use `atomicWrite`. The cost log, provenance chain, and the new
dead-letter queue (Feature Pass 001) are append-only JSONL files
written with `appendFile` (POSIX `O_APPEND`) under a single-writer
mutex.

I rewrote that bullet to describe the two write idioms accurately.
This was a source-contradicting claim on the same page as F-12, so I
included it in the F-12 fix rather than filing a new finding.

### Files

- `SECURITY.md` — corrected token-storage claim; corrected
  durable-write race-condition bullet.

---

## 4. F-13 — `BUILD-SUMMARY.md` inventory drift

### Problem

`BUILD-SUMMARY.md` was written at the end of Phase 5 (60 source files,
19 test files, 219 tests, 7,692 source LoC, 3,295 test LoC, 1,175 doc
LoC) and was not updated during Phase 7 (audit fix pass) or the
Feature Pass 001 pre-release pass. It carried:

- Wrong headline numbers on the top-level table.
- `src/utils/hash.ts` still listed in §4, despite being deleted as
  L-DUP-1 during Phase 7.
- No rows for any Feature Pass 001 files (`cli/commands/logs.ts`,
  `daemon/lint-scheduler.ts`, `ingestion/dead-letter.ts`) or their
  tests (`lint-scheduler.test.ts`, `dead-letter.test.ts`,
  `logs-command.test.ts`, `deletion-handling.test.ts`).
- Missing entries for new top-level docs (`CONTRIBUTING.md`,
  `SECURITY.md`, `ROADMAP.md`, `FEATURE-PASS-001.md`, `AUDIT-REPORT.md`,
  `AUDIT-REPORT-V2.md`, `AUDIT-FIXES.md`).
- `§15 Known gaps` still listed `CONTRIBUTING.md` and `SECURITY.md`
  as "not written" even though both exist.
- Per-file test counts that had drifted (e.g. `mcp-server.test.ts`
  listed as 10 when the file now has 15 tests).
- Footer "Auditing this document" block citing stale file counts.

### Fix

End-to-end pass over the file, driven by actual counts verified from
the working tree:

- **Top of file:** added an "Audit V2 fixes" banner above the existing
  "Feature Pass 001" and "Phase 7 audit" banners. Banners are stacked
  chronologically.
- **§1 Headline numbers:** 62 source files, ~8,820 source LoC, 24 test
  files, ~4,030 test LoC, **252 tests passing**, 6 top-level docs /
  1,787 doc LoC, ~200 KB CLI binary, ~140 KB daemon entry.
- **§1 Gates table:** added Gate 8 (Feature Pass 001) and Gate 9
  (Audit V2 fixes), both green.
- **§3 Repo layout:** updated file counts; added the four new
  top-level docs and the audit reports.
- **§4 Source inventory:**
  - `src/cli/` — now 16 files; added `cli/commands/logs.ts`.
  - `src/daemon/` — now 6 files; added `daemon/lint-scheduler.ts`;
    noted Feature Pass 001 changes on `entry.ts` (startup banner) and
    `config.ts` (`lint:` block).
  - `src/ingestion/` — now 11 files; added `ingestion/dead-letter.ts`;
    noted `queue.ts::archiveDeletedSources` and `wiki-writer.ts`
    M-SEC-1 changes.
  - `src/watcher/` — noted `deletedPaths` tracking.
  - `src/wiki/` — noted orphan frontmatter fields on `page.ts`.
  - `src/server/` — noted F-7 change on `middleware.ts`, M-SEC-1/2 on
    `tools.ts` and `index.ts`.
  - `src/utils/` — now 6 files; **removed** the `utils/hash.ts` row
    (deleted as L-DUP-1); noted `sanitize.ts` L-SEC-3 change and
    `types.ts` `archive` OperationType addition.
- **§5 Test inventory:** 24 files / ~4,030 LoC / **252 tests**;
  18 unit files / 214 tests; 6 integration files / 38 tests. Added
  rows for `lint-scheduler.test.ts` (6), `dead-letter.test.ts` (7),
  `logs-command.test.ts` (5), `deletion-handling.test.ts` (2), and
  `sanitize.test.ts` (7). Fixed drifted counts (`mcp-server.test.ts`
  10 → 15, `middleware.test.ts` 13 → 14 for the new F-7 case).
- **§6 Documentation inventory:** added `CONTRIBUTING.md` (165 LoC),
  `SECURITY.md` (113 LoC, with F-12 note), `ROADMAP.md` (123 LoC).
  Refreshed LoC on README, architecture, configuration, cli-reference,
  mcp-tools, provenance.
- **§9 Quality gates:** refreshed `pnpm test` tail (24 files / 252
  tests) and build sizes (~21 KB index, ~140 KB daemon, ~200 KB cli).
- **§10 CLI surface:** added the `wotw logs [-n N] [-f/--follow]` row.
- **§12 Configuration surface:** added the `lint:` block and
  `ingestion.dead_letter_file` to the canonical YAML dump.
- **§15 Known gaps:** removed the `CONTRIBUTING.md` and `SECURITY.md`
  "not written" entries (both exist now).
- **"Auditing this document" footer:** updated the file-count cheatsheet
  (60 → 62, 19 → 24, 7692 → ~8820, 3295 → ~4030, 219 → 252, 1175 →
  1787 including the three new top-level docs).

### Files

- `BUILD-SUMMARY.md` — inventory + headline numbers + banners brought
  into agreement with the working tree.

---

## 5. Quality gates (after fix pass)

All five gates green, measured on the fixed tree:

```bash
$ pnpm typecheck
tsc --noEmit        # 0 errors

$ pnpm lint
eslint src test --ext .ts   # 0 errors, 0 warnings

$ pnpm format:check
prettier --check "src/**/*.ts" "test/**/*.ts"
All matched files use Prettier code style!

$ pnpm test
 Test Files  24 passed (24)
      Tests  252 passed (252)
   Duration  ~11s

$ pnpm build
ESM dist/cli/index.js        199.97 KB
ESM dist/index.js             20.89 KB
ESM dist/daemon/entry.js     140.53 KB
ESM ⚡️ Build success in 62ms
DTS ⚡️ Build success in 3047ms
```

Test-count delta: **251 → 252** (+1 from the F-7 regression test in
`middleware.test.ts`). No other tests were added, removed, or
modified.

---

## 6. Files changed (complete list)

- `src/server/middleware.ts` — F-7
- `test/unit/middleware.test.ts` — F-7 regression
- `SECURITY.md` — F-12 (token storage + durable-write idiom)
- `BUILD-SUMMARY.md` — F-13 (inventory + headline numbers)
- `AUDIT-V2-FIXES.md` — this file

No other files were touched in this pass.

---

## 7. Verification grep (post-fix)

A quick sanity sweep to confirm the fixes landed:

```bash
# F-7 — the raw `!==` comparison is gone from the legacy auth branch
$ grep -n "provided !== opts.authToken" src/server/middleware.ts
(no matches)

$ grep -n "safeEqual" src/server/middleware.ts
20:function safeEqual(a: string, b: string): boolean {
149:    if (!safeEqual(provided, opts.authToken)) {

# F-12 — the false hashing claim is gone
$ grep -n "SHA-256 digests" SECURITY.md
(no matches)

$ grep -n "stored verbatim" SECURITY.md
111:- **Token storage.** Multi-user tokens are stored verbatim in
```

All expected.
