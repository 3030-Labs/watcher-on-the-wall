# AUDIT-FIXES — watcher-on-the-wall v0.1.0

**Date:** 2026-04-08
**Source audit:** `AUDIT-REPORT.md` (independent, read-only, 2026-04-08)
**Scope:** Every finding from the audit resolved in a single pass — 16/16.
**Result after fixes:** `pnpm typecheck`, `pnpm lint`, `pnpm format:check`,
`pnpm build` all clean. Tests went from **219 / 19 files** → **231 / 20 files**.

---

## Count summary

| Severity | Count | Status |
|---|---|---|
| HIGH     | 5 | Fixed |
| MEDIUM   | 3 | Fixed |
| LOW      | 8 | Fixed |
| **Total**| **16** | **Fixed** |

---

## HIGH — documentation drift (all code is correct, docs were stale)

### H-DOC-1 — wrong file paths in architecture doc
Referenced `src/ingestion/pipeline.ts` and `src/compounding/scheduler.ts`,
neither of which exist. The real files are `src/ingestion/queue.ts` and
`src/compounding/engine.ts`.
**Files touched:** `docs/architecture.md`

### H-DOC-2 — fork→spawn drift
The architecture doc and the CLI reference both described the daemon as
using `child_process.fork`, but D-16 replaced that with `spawn(..., {
detached: true, stdio: 'ignore' })`. Language corrected.
**Files touched:** `docs/architecture.md`, `docs/cli-reference.md`

### H-DOC-3 — `synthesize` / `audit` provenance types
`docs/architecture.md` and `docs/provenance.md` still referenced a
`"synthesize"` provenance type (and `provenance.md` also listed `"audit"`).
The actual implementation (`src/provenance/chain.ts`) uses the canonical set
`"ingest" | "query" | "compound"`.
**Files touched:** `docs/architecture.md`, `docs/provenance.md`

### H-DOC-4 — wrong wiki categories in directory tree
The architecture doc's directory tree listed categories `events/`,
`decisions/`, and `other/` that do not exist. The real category dirs in
`src/wiki/store.ts` are `concepts/`, `entities/`, `sources/`,
`comparisons/`, `syntheses/`, and `queries/`.
**Files touched:** `docs/architecture.md`

### H-DOC-5 — wrong category in `get_stats` example
`docs/mcp-tools.md` showed an example `get_stats` response using a
`"decision"` category. Replaced with the valid `"synthesis"`.
**Files touched:** `docs/mcp-tools.md`

---

## MEDIUM — code fixes (security + pipeline correctness)

### M-SEC-1 — `resolveWikiPath` substring-check bypass
The previous implementation normalized separators to `/` and checked for
`..` as a substring. That missed three real attack shapes: Windows absolute
paths (`C:/etc/passwd`), POSIX absolute paths, and legitimate filenames
containing `..`. Rewrote `resolveWikiPath` using the standard Node idiom:
`path.resolve(wikiRoot, input)` + `path.relative(wikiRoot, ...)` + reject
if the relative form starts with `..` or is absolute. Added three
integration tests that lock in the Windows-drive-letter, relative-prefix
traversal, and valid-nested-path behaviors. The helper is also exported as
`_resolveWikiPathForTests` for future unit coverage.
**Files touched:** `src/server/tools.ts`, `test/integration/mcp-server.test.ts`

### M-SEC-2 — no-auth safety rail
The MCP server used to silently accept every request whenever both
`server.auth_token` and `multi_user.enabled` were unset. That combination
is sometimes legitimate (trusted localhost only) but the old behavior gave
no warning and happily bound to `0.0.0.0` if the operator set it — a
genuine footgun for a LAN-exposed wiki. The server now:
  1. Logs a loud WARN banner at startup whenever auth is disabled.
  2. **Refuses to start** when auth is disabled AND `server.host` is not
     a loopback address (`127.0.0.1`, `::1`, `localhost`, or the
     `127.0.0.0/8` block).
Added two integration tests: one verifies the refuse-to-start path on
`0.0.0.0`, the other verifies the warn-and-continue path on `127.0.0.1`.
**Files touched:** `src/server/index.ts`, `test/integration/mcp-server.test.ts`

### M-PIPE-1 — lazy provenance hashing window
`recordProvenance` used to hash source and wiki files lazily at the end of
a batch, opening a narrow race window where a concurrent writer could mutate
a file between ingestion and hashing. Pipeline restructured so that
(1) source files are hashed eagerly right after prompt build (step 1a) and
(2) wiki output files are hashed eagerly right after the index/search
rebuild (step 6a), with the precomputed hashes threaded into
`recordProvenance`. Existing provenance tests still pass.
**Files touched:** `src/ingestion/queue.ts`

---

## LOW — code quality / polish

### L-DUP-1 — duplicate hash utilities
`src/utils/hash.ts` and `src/provenance/hash.ts` both implemented SHA-256
helpers with slightly different signatures. Consolidated into
`src/provenance/hash.ts` with backwards-compatible aliases (`sha256`,
`sha256Json`, `stableStringify`, `sha256FileSync`) and deleted
`src/utils/hash.ts`. Updated the single external import site
(`src/watcher/event-classifier.ts`) and the re-export list in
`src/index.ts`.
**Files touched:** `src/provenance/hash.ts`, `src/utils/hash.ts` (deleted),
`src/watcher/event-classifier.ts`, `src/index.ts`

### L-CODE-1 — `path.relative` for provenance record paths
`recordProvenance` used to build wiki-relative paths via string slicing.
Switched to `path.relative(wikiRoot, abs)` via a small `toRel` helper.
Fixed as part of the M-PIPE-1 pipeline restructure.
**Files touched:** `src/ingestion/queue.ts`

### L-CODE-2 — fork comment drift in CLI entry
A stale comment in `src/cli/index.ts` referred to forking the daemon;
corrected to match the D-16 detached-spawn reality.
**Files touched:** `src/cli/index.ts`

### L-CODE-3 — duplicated `computeCostToday` in CLI status
`src/cli/commands/status.ts` reimplemented the cost-log summing logic that
already lived inside `CostTracker`. Extracted the shared logic into an
exported `sumCostsForDay(...)` helper from `cost-tracker.ts` and deleted
the CLI copy.
**Files touched:** `src/ingestion/cost-tracker.ts`, `src/cli/commands/status.ts`

### L-CODE-4 — wiki-writer dotfile over-rejection
The wiki-writer rejected any relative path starting with `.` (to block
`..`), which incorrectly rejected legitimate filenames like `.eslintrc`.
Tightened to use `isAbsolute` + the precise `..` / `..${sep}` checks.
**Files touched:** `src/ingestion/wiki-writer.ts`

### L-PERF-1 — uncached `CostTracker.spentToday()`
Every status query re-read the entire cost log from disk. Added a small
`{ cachedDay, cachedTotal }` cache updated inside `record()` and consulted
by `spentToday()`.
**Files touched:** `src/ingestion/cost-tracker.ts`

### L-SEC-1 — constant-time token comparison comment
The constant-time comparison in `token-store.ts` was correct, but the
comment didn't explain *why* the naive approach is unsafe. Expanded the
comment with the entropy math (256-bit tokens, 10^58 years brute force vs
10^19 with a timing oracle) so future maintainers don't weaken it.
**Files touched:** `src/multi-user/token-store.ts`

### L-SEC-2 — cli-invoker env comment
The comment above the full-env propagation in `cli-invoker.ts` falsely
implied `ANTHROPIC_API_KEY` was *not* forwarded. In fact it IS forwarded
whenever the shell has it set, because we inherit the parent's environment
wholesale — which is the deliberate, correct behavior for CLI mode.
Corrected the comment to describe the actual behavior.
**Files touched:** `src/ingestion/cli-invoker.ts`

### L-SEC-3 — `password-in-url` regex over-match risk
The sanitizer's `password-in-url` rule correctly did not match bare
`user@host` email addresses, but the behavior was undocumented. Added a
design-comment explaining the `\w+://` prefix is load-bearing, tightened
the userinfo character class to also exclude `/`, and created a new
test file `test/unit/sanitize.test.ts` with 7 regression tests covering:
  - http(s) `user:password@host` URLs (should redact)
  - non-http `postgres://` URLs with credentials (should redact)
  - bare email addresses (should NOT touch)
  - `mailto:` URIs (should NOT touch)
  - trigger-reporting round-trip
**Files touched:** `src/utils/sanitize.ts`, `test/unit/sanitize.test.ts` (new)

---

## Verification

```
$ pnpm typecheck   # clean
$ pnpm lint        # clean
$ pnpm format:check # clean
$ pnpm test        # 231 passed (231) across 20 files
$ pnpm build       # ESM + DTS build success
```

Test growth: **219 → 231** (12 new tests — 7 sanitize unit + 3 M-SEC-1 path
safety + 2 M-SEC-2 no-auth safety rail). One new test file: `test/unit/sanitize.test.ts`.

No behavioral regressions. Every pre-existing test still passes.
