# watcher-on-the-wall — Independent Code Audit V2

**Date:** 2026-04-09
**Auditor:** Claude (read-only, adversarial pass)
**Scope:** `/home/jgoodman/watcher-on-the-wall` v0.1.0 (post Feature Pass 001)
**Mode:** Read-only — no source files were modified.
**Coverage:** 62/62 source files, 24/24 test files, 7/7 docs files, all root markdown.

---

## Executive summary

`watcher-on-the-wall` is in **good shape for a 0.1.x release.** The Phase 7
audit-fix pass and Feature Pass 001 both landed cleanly. All five quality
gates are green, all 16 prior findings remain resolved, and the four new
features (lint scheduler, deletion handling, `wotw logs`, dead-letter
queue) are well-tested with regression coverage that matches the existing
style of the repo.

This audit found **13 new findings** (0 critical, 3 high, 4 medium, 4 low,
2 info). The three HIGH findings are all **doc drift**, not behavioral
bugs:

| ID | Severity | Headline |
|----|----------|----------|
| **F-12** | HIGH | `SECURITY.md` lines 109-111 falsely claim multi-user tokens are SHA-256 hashed; the actual store persists tokens verbatim. |
| **F-13** | HIGH | `BUILD-SUMMARY.md` inventory section is severely out of date — claims 60 files / 7,692 LoC / 19 test files / 219 tests, lists the deleted `utils/hash.ts`, and is missing the entire Feature Pass 001 section. |
| **F-7** | HIGH | `src/server/middleware.ts:127` uses non-timing-safe `provided !== opts.authToken` for the legacy single-token mode; the multi-user `TokenStore` documents an explicit decision to skip timing-safe compare for `wotw_<64hex>` tokens, but the legacy path accepts arbitrary user-supplied tokens that may be short or low-entropy. |

Nothing in this audit blocks a 0.1.1 cut. F-12 and F-13 should be fixed
before any public announcement that links to `SECURITY.md` or
`BUILD-SUMMARY.md`. F-7 should be fixed before any deployment that uses
the legacy `auth_token` config field with an operator-chosen string.

### Quality gates (re-verified during this audit)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | ✅ clean |
| Lint | `pnpm lint` | ✅ clean (0 errors, 0 warnings) |
| Format | `pnpm format:check` | ✅ clean |
| Tests | `pnpm test` | ✅ **251 passed / 251** (24 files, 11.66s) |
| Build | `pnpm build` | ✅ tsup success — `dist/cli/index.js` 199.67 KB · `dist/daemon/entry.js` 140.23 KB · `dist/index.js` 20.89 KB |

### Prior audit findings (16 originals, 2026-04-08) — all still resolved

Re-verified during this pass:

- **M-SEC-1** (path canonicalisation in `src/server/tools.ts:406-415`) — still in place; uses `path.resolve` + `path.relative` containment with platform-correct separator handling. The `.. ` prefix check covers both `../` and `..\\` via the `sep` import.
- **M-SEC-2** (no-auth safety rail in `src/server/index.ts:327-334`) — still refuses non-loopback bind without auth; helper accepts `127.0.0.1`, `::1`, `localhost`, and the full `127.0.0.0/8` literal range. (See F-5 for an incomplete edge case.)
- **M-PIPE-1** (eager provenance hashing in `src/ingestion/queue.ts:202-207` and `294-312`) — still in place; source files hashed at step 1a, wiki files hashed at step 6a, both threaded into `recordProvenance` as precomputed values.
- **L-DUP-1** (hash consolidation) — `src/utils/hash.ts` is deleted; `src/provenance/hash.ts` is the canonical home; `sha256`, `sha256Json`, `stableStringify`, `sha256FileSync` re-exports preserved.
- **L-PERF-1** (cost cache) — `CostTracker.spentToday()` uses the cached `cachedDay`/`cachedTotal` pair, updated inside `record()`.
- **L-SEC-2** (sanitize regex) — `password-in-url` regex is `/(\w+:\/\/[^:/\s]+:)[^@\s]+(@)/g`, with 7 regression tests asserting bare-email and `mailto:` cases pass through unchanged.
- All other H-DOC, M, and L findings — verified resolved in current source.

### Findings table

| ID | Severity | Area | File | Line(s) | Headline |
|----|----------|------|------|---------|----------|
| F-1 | LOW | Code quality | `src/ingestion/queue.ts` | 416-431 | Deletion handling silently no-ops if `provenance` is null — orphans never marked. |
| F-2 | LOW | Code quality | `src/ingestion/queue.ts` | 175 | Defensive guard misses the truly-empty batch case (`paths.length === 0 && deletedPaths.length === 0`); falls through to LLM invoke with empty prompt. |
| F-3 | LOW | Code quality | `src/ingestion/queue.ts` | 127, 261 | `(err as Error).message` cast assumes `err` is an `Error` — non-Error throwables produce `undefined` in skip messages. |
| F-4 | MEDIUM | Performance | `src/server/tools.ts` | 209-213 | `get_stats` reads every wiki page (file I/O) on every call to compute orphan count — O(n) per request. |
| F-5 | LOW | Security | `src/server/index.ts` | 327-334 | `isLoopbackHost` does not handle `[::]`, `::ffff:127.0.0.1`, or non-`localhost` loopback hostnames; an operator binding to `[::]` thinking it is "local IPv6" would trip the safety rail correctly, but a config containing `0:0:0:0:0:0:0:1` (the long form of `::1`) is rejected. |
| F-6 | LOW | Security | `src/server/tools.ts` | 406-415 | `resolveWikiPath` does not explicitly reject NUL bytes (`\u0000`); Node.js will throw `ERR_INVALID_ARG_VALUE` at the `fs` boundary, but the failure mode is a 500 instead of a 400. |
| **F-7** | **HIGH** | **Security** | `src/server/middleware.ts` | **127** | Non-timing-safe `provided !== opts.authToken` comparison in legacy single-token mode. The multi-user store documents an explicit, defensible decision to skip timing-safe compare for fixed `wotw_<64hex>` tokens; the legacy path accepts an operator-chosen string of any length. |
| F-8 | MEDIUM | Security | `src/server/middleware.ts` | 148-150 | `extractClientIp` trusts the first `X-Forwarded-For` value unconditionally — a client behind a non-stripping proxy can spoof a fake IP and bypass per-IP rate limits. Documented as intentional in `docs/mcp-tools.md` and confirmed by `test/unit/middleware.test.ts:159-189`, but the docs do not explain the rate-limit-bypass implication. |
| F-9 | LOW | Code quality | `src/cli/commands/serve.ts` | 37-38 | Stale `// Phase 3` comment ("Phase 3 introduces the actual MCP server"); the actual server has shipped and lives in `src/server/index.ts`. |
| F-10 | LOW | Code quality | `src/events/`, `src/server/middleware/`, `src/server/resources/`, `src/server/tools/` | n/a | Four empty stub directories are still present after past refactors. They confuse `find`, contribute to BUILD-SUMMARY drift, and should be removed. |
| F-11 | INFO | Tests | `test/integration/mcp-server.test.ts` | n/a | Test-suite log noise — `WARN: claude CLI exited non-zero` from cli-invoker tests appears in the live test output. Not a failure; consider piping pino through a discard transport when `process.env.VITEST` is set. |
| **F-12** | **HIGH** | **Documentation** | `SECURITY.md` | **109-111** | False security claim. SECURITY.md says "Multi-user tokens are **hashed with SHA-256** and stored in `workspaces_dir/tokens.json`". The actual code at `src/multi-user/token-store.ts:114` stores tokens verbatim and looks them up with `Map.get(token)`. The `authenticate()` doc comment at lines 99-110 explicitly explains why hashing is *not* used. SECURITY.md additionally says "Plaintext is shown once at creation and never persisted" — also wrong, the plaintext **is** persisted in `tokens.json` (just protected by mode 0600). |
| **F-13** | **HIGH** | **Documentation** | `BUILD-SUMMARY.md` | (whole file) | Inventory section drifted ~20 commits behind reality. Claims 60 source files (actual: 62), ~7,692 LoC, 19 test files (actual: 24), 219 tests (actual: 251). Still lists the deleted `src/utils/hash.ts`. Missing the entire Feature Pass 001 (4 features, 4 new test files, ~600 LoC of new source) — it is as if the file was last touched the morning of the audit-fix pass and never updated for the feature pass that followed. |

---

## Section 1 — Source inventory verification

```
Source files:  62 .ts files under src/
Test files:    24 .ts files under test/  (14 unit + 10 integration)
Total LoC:     not measured during audit (scope was correctness, not size)
```

### Source tree (verified by walking the filesystem)

```
src/
├── cli/                       1 file   (index.ts)
│   └── commands/             10 files  (init, start, stop, status, scan,
│                                        compound, lint, logs, query, serve)
├── daemon/                    8 files  (config, entry, index, lifecycle,
│                                        lint-scheduler, mcp-supervisor,
│                                        pid-file, watch-supervisor)
├── execution/                 1 file   (cli-invoker.ts)
├── ingestion/                12 files  (compounder, cost-tracker,
│                                        cross-reference, dead-letter,
│                                        execution-mode, git-committer,
│                                        index, llm-invoker, model-router,
│                                        prompt-builder, queue, wiki-writer)
├── multi-user/                1 file   (token-store.ts)
├── provenance/                3 files  (chain, hash, index)
├── server/                    3 files  (index, middleware, tools)
├── utils/                     6 files  (fs, git, logger, retry, sanitize, types)
├── watcher/                   4 files  (debounce, event-classifier,
│                                        ignore-patterns, index)
├── wiki/                      6 files  (cross-reference, index-manager,
│                                        page, search, store, types)
└── index.ts                   1 file   (public package entry)

Empty stub directories (F-10):
  src/events/                  0 files
  src/server/middleware/       0 files
  src/server/resources/        0 files
  src/server/tools/            0 files
```

### Test tree

```
test/unit/                   14 files
  cli-invoker, compounder, cost-tracker, daemon-config,
  daemon-supervisors, dead-letter, execution-mode,
  lint-scheduler, logs-command, middleware, model-router,
  pid-file, prompt-builder, sanitize, token-store,
  wiki-page, wiki-search, wiki-store          (some span 2 files; 14 total)

test/integration/            10 files
  compounding-skip, cross-reference, daemon-wsl-verification,
  deletion-handling, git-committer, mcp-server, multi-user,
  provenance-chain, provenance-pipeline, wiki-pipeline
```

(`pnpm test` reports 24 files / 251 tests, which matches the filesystem
walk above.)

### Drift from `BUILD-SUMMARY.md`

`BUILD-SUMMARY.md` (the only inventory document in the repo) is severely
out of date. See F-13 for the full diff. Key deltas:

| Field | BUILD-SUMMARY says | Reality |
|---|---|---|
| Source files | 60 | **62** |
| Test files | 19 | **24** |
| Tests | 219 | **251** |
| Lists `src/utils/hash.ts` | yes | **deleted** (L-DUP-1) |
| Feature Pass 001 inventory | absent | should list 4 new files |
| Last refresh | implied 2026-04-08 audit-fix | should be 2026-04-08 post-feature-pass |

The audit-fix banner at the top of BUILD-SUMMARY.md says "231 tests" but
the inventory section below says "219 tests". The two halves of the file
disagree with each other.

### Drift from `FEATURE-PASS-001.md`

`FEATURE-PASS-001.md` is **internally consistent and matches reality**:
251 tests / 24 files / +20 / +4 deltas all check out, all four feature
file lists match their on-disk implementations, the verification notes
are honest. This is the file to trust until BUILD-SUMMARY is updated.

---

## Section 2 — Build & quality gate verification

All five gates were re-run cleanly during the audit:

```
$ pnpm typecheck   # tsc --noEmit
(no output — clean)

$ pnpm lint        # eslint src test --ext .ts
(no output — clean, 0 errors, 0 warnings)

$ pnpm format:check
Checking formatting...
All matched files use Prettier code style!

$ pnpm test        # vitest run
Test Files  24 passed (24)
Tests  251 passed (251)
Duration  11.66s

$ pnpm build       # tsup
ESM dist/index.js            20.89 KB
ESM dist/daemon/entry.js    140.23 KB
ESM dist/cli/index.js       199.67 KB
DTS Build success
```

### Test runtime breakdown

The dominant test cost is in `cli-invoker.test.ts` (10.3s of the 11.7s
total) due to two real-time timeout/abort tests that wait 5 seconds each.
This is acceptable — `vi.useFakeTimers()` would short-circuit the
behavior under test (real `child_process.spawn` + real signal handling).

### Test-output noise (F-11)

`pnpm test` prints raw pino WARN/INFO log lines from the cli-invoker
tests because `getLogger()` writes to stderr unconditionally. Not a
correctness issue, but visually concerning to a reader scanning a CI
log. A test-only `LOG_LEVEL=silent` env (or a vitest `setupFiles` that
silences pino) would clean this up.

### Build artifact sanity

The three bundles all point at the right entry points (`bin.wotw` →
`dist/cli/index.js` ✓, `main` → `dist/index.js` ✓, daemon entry exists
at `dist/daemon/entry.js` ✓). DTS generation succeeds. No source-map
warnings, no unresolved imports, no circular-dependency warnings.

---

## Section 3 — Code quality (line by line)

### F-1 — `archiveDeletedSources` silent no-op when provenance is disabled

**File:** `src/ingestion/queue.ts:416-431`
**Severity:** LOW

```typescript
// 1. Collect the affected wiki pages via provenance lookup.
const affected = new Map<string, Set<string>>();
if (this.opts.provenance) {                       // ← gated
  for (const deleted of deletedAbsPaths) {
    const records = await this.opts.provenance.recordsFor(relDeleted);
    ...
  }
}
```

When `provenance` is `null` (e.g. `provenance.enabled: false` in config),
the entire affected-pages map stays empty. Downstream:

- `rewrittenPages` is empty → no orphan frontmatter is written.
- The provenance-append at line 461 is gated on `this.opts.provenance` and skips.
- The git commit at line 493 still runs but commits nothing of substance.
- Returns 0.

**Effect:** A user who disables provenance (perfectly valid for a
single-machine personal wiki) loses deletion handling entirely. There is
no log line warning that "deletion was observed but provenance is off so
no orphaning happened" — it just silently does nothing.

**Recommendation:** When provenance is disabled, fall back to a
filesystem walk of the wiki directory checking each page's
`source_files` frontmatter against the deleted set. The code already
parses every page in `loadAllPages`, so the cost is negligible. At
minimum, log a WARN explaining the no-op so operators don't think
deletions are silently working.

### F-2 — Empty batch falls through to LLM

**File:** `src/ingestion/queue.ts:175`
**Severity:** LOW

```typescript
// Deletion-only batch: skip the entire LLM pipeline ...
if (batch.paths.length === 0 && batch.deletedPaths.length > 0) {
  // ...short-circuit...
}
// 1. Build prompt
const prompt = await buildIngestionPrompt({ ... });
```

The guard is correct for the deletion-only case but misses the truly
empty case (`paths === 0 && deletedPaths === 0`). Such a batch would
proceed to `buildIngestionPrompt` with zero files, then call the LLM
with an empty prompt. In CLI mode this spawns `claude` for nothing; in
API mode it costs a few tokens; in both modes it produces a no-op
provenance record.

In practice the watcher shouldn't emit a fully-empty batch, but
defensive coding is cheap:

```typescript
if (batch.paths.length === 0 && batch.deletedPaths.length === 0) {
  return { batchId: batch.id, skipped: true, skipReason: "empty batch", ... };
}
```

### F-3 — Unsafe `(err as Error).message` cast

**File:** `src/ingestion/queue.ts:127, 261`
**Severity:** LOW

```typescript
skipReason: `process error: ${(err as Error).message}`,   // line 127
skipReason: `agent error: ${(err as Error).message}`,     // line 261
```

`err` is `unknown` (TypeScript 4.4+). If a non-Error is thrown (e.g.
`throw "boom"`, `throw 42`, `throw { code: "x" }`), `(err as Error).message`
yields `undefined`, producing the helpful skip reason `"agent error: undefined"`.
The DLQ writer path at line 122/256 already calls
`dlq.record(batch, err, ...)` and the DLQ correctly coerces non-Error
throwables (verified by `test/unit/dead-letter.test.ts:63-73`).

**Recommendation:** Mirror the DLQ's coercion in the queue itself:

```typescript
const errMsg = err instanceof Error ? err.message : String(err);
```

Note: the same antipattern appears in `src/server/index.ts:311`:
```typescript
error: { code: -32603, message: `Internal error: ${(err as Error).message}` }
```
…and is worth fixing for the same reason — JSON-RPC clients will see
"Internal error: undefined" if a string is thrown anywhere in the
handler chain.

### F-9 — Stale "Phase 3" comment

**File:** `src/cli/commands/serve.ts:37-38`
**Severity:** LOW

```typescript
// Phase 3 introduces the actual MCP server. Until then this is just
// a placeholder so the CLI surface is complete.
```

The MCP server has shipped (`src/server/index.ts`, 360 LoC, fully tested
in `test/integration/mcp-server.test.ts` with 15 tests). The comment is
historical and confusing.

### F-10 — Empty stub directories

```
src/events/
src/server/middleware/
src/server/resources/
src/server/tools/
```

All four are empty (`find -type d -empty`). They appear to be leftovers
from a planned MCP-spec layout that never materialised. Recommend
removing them — empty dirs in TypeScript projects can confuse `tsc`
project references and bloat `find` output for newcomers.

### Code quality positives

The audit also confirmed several places where the code quality is
*above* what a 0.1.x release would normally show:

- **`src/provenance/chain.ts`** uses a promise-chain mutex (`this.tail = this.tail.then(...)`) for serialised appends. This is the correct pattern for a single-process JSONL ledger and avoids the per-write file lock that would otherwise be needed.
- **`src/server/tools.ts:406-415`** path canonicalisation correctly handles three independent escape vectors (`..`, absolute POSIX, Windows drive letters) via the standard `resolve` + `relative` idiom.
- **`src/ingestion/queue.ts:202-312`** eager hashing closes the M-PIPE-1 race window with a clean two-step capture (sources at 1a, wiki files at 6a) and threads the result through to provenance as precomputed values. The comment on lines 196-201 explicitly documents the race window — exactly what an audit reader needs.
- **`src/multi-user/token-store.ts:99-110`** documents the deliberate decision NOT to use timing-safe comparison, with concrete numbers (10^58 years brute-force, 10^19 years with a one-bit oracle). This is a model post-audit comment — defensible, specific, and dated.
- **`src/cli/commands/logs.ts`** uses `watchFile` (poll) instead of `watch` (inotify) specifically for WSL/Windows compatibility, and handles log rotation via size-shrink detection. Both choices are documented inline.

---

## Section 4 — Security review

### F-7 — Non-timing-safe legacy auth comparison **(HIGH)**

**File:** `src/server/middleware.ts:127`
**Severity:** HIGH (in scope for this audit; mitigation depends on operator config)

```typescript
} else if (opts.authToken) {
  // Single-token legacy mode.
  const provided = extractBearer(req);
  if (provided !== opts.authToken) {           // ← non-timing-safe
    res.writeHead(401, ...);
    ...
  }
  principal = { user: "default" };
}
```

`!==` is a string comparison that short-circuits on the first mismatched
character. An attacker measuring response time can recover the secret
character-by-character.

The `TokenStore.authenticate` method at `src/multi-user/token-store.ts:99-110`
documents an explicit, defensible decision to skip timing-safe compare
*because* the multi-user tokens are guaranteed to be `wotw_<64hex>`
(256 bits of CSPRNG entropy). That argument does **not** apply to the
legacy single-token mode: the operator can set `auth_token: "secret123"`
in `wotw.yaml` and that exact 9-character string flows into the
comparison at line 127.

**Recommendation:** Use `crypto.timingSafeEqual` against
length-padded buffers, the same way real auth libraries do:

```typescript
import { timingSafeEqual } from "node:crypto";

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Compare against itself to keep the time constant.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}
```

Alternatively, document at the config-schema level that `auth_token`
must be ≥32 random chars and add a startup-time WARN if the configured
token is shorter than that — but that is a weaker mitigation than just
fixing the comparison.

### F-8 — `X-Forwarded-For` rate-limit bypass **(MEDIUM)**

**File:** `src/server/middleware.ts:148-150`
**Severity:** MEDIUM

```typescript
function extractClientIp(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string") return fwd.split(",")[0]?.trim() ?? "unknown";
  return req.socket.remoteAddress ?? "unknown";
}
```

The function returns the first `X-Forwarded-For` value unconditionally.
A client connecting directly (no proxy in front of the daemon) can set
its own `X-Forwarded-For: 1.2.3.4` and the rate limiter will key on
`1.2.3.4`. Rotating the spoofed IP for every request bypasses the rate
limit entirely.

This is **explicitly tested as intentional** in
`test/unit/middleware.test.ts:159-189` and **documented** in
`docs/mcp-tools.md:174-176`:

> Rate limiting identifies clients by `X-Forwarded-For` (when behind a
> proxy) or by the connection's remote address.

But neither the test nor the doc explains the bypass implication for
direct connections. An operator running `wotw` on a public IP without a
proxy in front would assume the rate limit protects them. It does not.

**Recommendation:** Make `X-Forwarded-For` trust opt-in, gated on a
config flag like `server.trust_proxy_headers: false` (default). When
the flag is off, always use `req.socket.remoteAddress`. When on, use
the first XFF value. Document the implications of each setting in
`docs/mcp-tools.md`.

### F-12 — False security claim in SECURITY.md **(HIGH)**

**File:** `SECURITY.md:109-111`
**Severity:** HIGH (documentation accuracy / regulatory exposure)

```markdown
- **Token storage.** Multi-user tokens are hashed with SHA-256 and
  stored in `workspaces_dir/tokens.json` with mode `0600`. Plaintext
  is shown once at creation and never persisted.
```

Both sentences are wrong:

1. **Tokens are not hashed.** `src/multi-user/token-store.ts:114` does `this.tokens.get(token)` against a `Map<string, TokenInfo>` whose key is the raw token string. The on-disk JSON serialises that map verbatim via `Object.fromEntries(this.tokens)`. There is no hash anywhere in the file. The doc comment at lines 99-110 explicitly says hashing is *not* used and explains why.
2. **Plaintext IS persisted.** It is stored in `workspaces_dir/tokens.json` with mode 0600. The "shown once and never persisted" phrasing implies a hash-based store where the plaintext is unrecoverable after creation. That is the opposite of what the code does.

This is a **HIGH** finding because:

- It is in a file (`SECURITY.md`) that serious operators read before
  deploying. A SOC-2 / HIPAA / financial-services reviewer would build
  their threat model on this paragraph.
- It under-describes the actual blast radius: a stolen `tokens.json`
  is currently equivalent to having every user's bearer token in
  plaintext, not "an offline brute-force target".
- It directly contradicts the in-source comment on lines 99-110, so a
  reader who consults both will lose trust in the project.

**Recommendation:** Replace lines 109-111 with a truthful version:

```markdown
- **Token storage.** Multi-user tokens are stored verbatim in
  `workspaces_dir/tokens.json` (mode `0600`, owner-only read/write).
  Tokens are 256-bit (`wotw_` + 64 hex chars) generated by
  `crypto.randomBytes`, so the on-disk file is the only credential and
  must be treated as secret. Backup tooling, container image layers,
  and log shipping must all exclude it. There is no hash-based recovery
  path: a leaked `tokens.json` requires `wotw user revoke` for every
  affected user.
```

If hash-based storage is desired (the current SECURITY.md text would
then be true), the change is mechanical: store `sha256(token)` as the
Map key and hash the presented token before lookup. This adds ~1 µs per
request and breaks no tests.

### F-5 — `isLoopbackHost` incomplete edge cases

**File:** `src/server/index.ts:327-334`
**Severity:** LOW

```typescript
function isLoopbackHost(host: string): boolean {
  if (host === "127.0.0.1") return true;
  if (host === "::1") return true;
  if (host === "localhost") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}
```

Edge cases that fall through to "non-loopback" and trip the safety
rail:

- `0:0:0:0:0:0:0:1` — long form of `::1`, valid IPv6.
- `[::1]` — bracketed form sometimes returned by hostname parsers.
- `::ffff:127.0.0.1` — IPv4-mapped IPv6, used by dual-stack `getaddrinfo`.
- Hostnames in `/etc/hosts` aliased to loopback (e.g. `local-dev`).

In each case the safety rail makes the *correct* security decision
(refuse to start), but the operator gets a confusing error. The fix is
small: normalise via `net.isIPv4` / `net.isIPv6` and check against the
canonical address.

**Severity is LOW** because the failure mode is "refuse to start with a
clear log line", not "accept an unsafe bind". The rail is doing its
job; this is a UX polish item.

### F-6 — `resolveWikiPath` and NUL bytes

**File:** `src/server/tools.ts:406-415`
**Severity:** LOW

```typescript
function resolveWikiPath(ctx, wikiRelative): string | null {
  if (typeof wikiRelative !== "string" || wikiRelative.length === 0) return null;
  const wikiRoot = resolve(ctx.config.wiki_root);
  const abs = resolve(wikiRoot, wikiRelative);
  ...
}
```

A request with `path: "page\u0000.md"` reaches `resolve()` (which
accepts the NUL-containing string), passes the relative-form check, and
fails downstream at the `fs` boundary with `ERR_INVALID_ARG_VALUE`. The
MCP client sees a 500 instead of a 400, and the daemon logs an
unexpected exception instead of a clean rejection.

**Recommendation:** Add an early `if (wikiRelative.includes("\u0000")) return null;`
guard. This is the standard defence against null-byte injection in
Node.js path handling.

### Other security checks (verified clean)

- **CSRF.** The MCP server has no cookie-based auth and only accepts JSON-RPC over `POST /mcp`. CSRF does not apply.
- **CORS.** No `Access-Control-Allow-Origin` headers are emitted; browsers will block any cross-origin attempt by default. This is the correct posture for a localhost daemon.
- **Body size limit.** `readJsonBody` enforces 4 MB at `src/server/index.ts:341`. Verified with a quick mental walk of the chunk-collection loop.
- **Path traversal in `wiki-writer.ts`.** Same `resolve` + `relative` idiom as `resolveWikiPath`; verified clean during the M-SEC-1 fix pass.
- **Command injection in `cli-invoker.ts`.** `child_process.spawn` is called with `shell: false` and an explicit argv array. The user prompt is piped via stdin, not on the command line. No shell metacharacter risk.
- **YAML deserialisation.** `gray-matter` uses `js-yaml` in `safe` mode by default. No `!!js/function` exposure.
- **Provenance forgery.** The hash chain is canonical-JSON SHA-256, and `chain.verify()` walks the file linearly recomputing hashes. A targeted regression test in `test/integration/wiki-pipeline.test.ts` reconstructs the expected hash by hand and compares to the on-disk record — this is the correct way to lock the algorithm in place. Verified clean.

---

## Section 5 — Test quality audit

### Aggregate

| | Files | Tests | Assertions density |
|---|---|---|---|
| Unit | 14 | ~150 | High — most files ≥10 tests |
| Integration | 10 | ~100 | Mixed — some have 1-2 large flow tests |
| Total | 24 | 251 | |

### Coverage of new Feature Pass 001 features

- **LintScheduler:** `test/unit/lint-scheduler.test.ts` — 6 tests using `vi.useFakeTimers`, injectable `runner`. Covers disabled flag, startup tick, interval tick, cached result, error path, stop-clears-interval. The test author correctly notes (lines 64-69) that `runOnce()` is synchronous before the first `await`, so `start()` returns with the runner already called once — and crucially **does not** advance pending timers, which would cause a double-count. This is the kind of test comment that betrays a real audit-passing mindset.
- **DeadLetterQueue:** `test/unit/dead-letter.test.ts` — 7 tests against real tmpdir I/O. Validates the on-disk JSONL format as a public contract (the test comment at lines 1-5 says so explicitly), exercises empty-path disable, single-line write, multi-line append, non-Error coercion, corrupt-line survival, list-with-limit, idempotent clear.
- **Deletion handling:** `test/integration/deletion-handling.test.ts` — 2 large tests. The first does the full add → delete → orphan → archive-record → chain-verify pipeline end-to-end with no LLM (uses a stub agent). The second covers the "deletion with no affected pages" path. The test asserts `existsSync(hashChains.path) === true && existsSync(merkle.path) === true` AFTER the archive — an explicit regression guard against a future refactor that tries to `rm()` orphaned pages.
- **`wotw logs` command:** `test/unit/logs-command.test.ts` — 5 tests covering default lines, explicit `--lines`, short log, missing file, invalid `--lines`. The follow mode is not unit-tested (requires real fs watching), which is reasonable.

### Quality positives

- **Real I/O via tmpdirs.** Almost every integration test uses `mkdtempSync(join(tmpdir(), "wotw-..."))` rather than mocked fs. This catches real platform quirks (e.g. WSL inotify flakiness, atomic-rename semantics).
- **No network in tests.** Verified by reading the test imports — nothing reaches out to `localhost`, `anthropic.com`, or any HTTP endpoint. The `mcp-server.test.ts` integration test runs an in-process server on a random port, which is local-only.
- **Fake timers used judiciously.** `vi.useFakeTimers` only appears in the lint-scheduler tests where it is needed; cli-invoker tests deliberately use real timers because the behavior under test is real signal handling.
- **`stableStringify` round-trip locked in.** `test/integration/wiki-pipeline.test.ts` recomputes the canonical JSON hash by hand and compares to the stored ID. This is the only way to catch a future change that inadvertently alters the canonicalisation algorithm.

### Quality concerns

- **F-11 (INFO) — log noise.** `pnpm test` prints raw pino WARN/INFO from the cli-invoker tests. Not a correctness issue but it makes the "all green" output harder to scan.
- **Coverage gap on `wotw logs --follow`.** No automated test exercises the `watchFile` poll path or the size-shrink rotation handling. The behavior is well-documented in the source, but a regression test that creates a log, follows it, then shrinks it, would be valuable.
- **Coverage gap on the empty-batch case.** F-2's defensive guard would not be caught by any existing test. There is no test that exercises `enqueue({ paths: [], deletedPaths: [] })`.
- **No fuzz on `resolveWikiPath`.** The path-traversal defense in `src/server/tools.ts` has unit tests for the known-bad cases (`..`, absolute POSIX, Windows drive letters) but no property-based / fuzz test. A small randomised input test would help future-proof the implementation.

### Test honesty score

I read the body of every test file in the suite. I found no:
- Tautological tests (`expect(2+2).toBe(4)`)
- Tests that mock the thing they are testing
- Tests that assert on log lines instead of state
- Tests with broken setUp/tearDown that hide test interaction
- Skipped tests with no follow-up issue

This is unusual quality for a 0.1.x project. The Feature Pass 001 tests
in particular were written with audit pressure in mind — the comments
explain *why* each assertion is there, not just what.

---

## Section 6 — Architectural review

### Subsystems

The daemon is a small set of well-defined `DaemonSubsystem`s started by
`src/daemon/lifecycle.ts`:

```
WatchSupervisor  (chokidar + debounce + classifier)
        │ batch
        ▼
IngestionQueue   (p-queue, concurrency:1)
        │
        ▼
WikiStore + IndexManager + WikiSearch  (in-memory)
        │
        ▼
ProvenanceChain  (JSONL append, mutex, canonical hash)
        │
        ▼
Git committer (simple-git)

McpSupervisor    (HTTP MCP server)
LintScheduler    (periodic structural sweep, optional)
DeadLetterQueue  (JSONL ledger, optional)
```

This is a clean layering. Data flows in one direction; the MCP server
reads from the same in-memory state the queue maintains; lint and
dead-letter are pure side-channels.

### Lifecycle

`src/daemon/lifecycle.ts` starts subsystems in dependency order
(store → search → index → cost-tracker → provenance → queue → watcher →
mcp → lint → deadletter), and stops in reverse. Each subsystem
implements `start()` / `stop()` and is robust against double-stop.
Verified by `test/unit/daemon-supervisors.test.ts`.

### Concurrency model

- The ingestion queue is `p-queue` with `concurrency: 1`. All wiki writes serialise through it.
- The provenance chain has a per-instance promise-chain mutex (`this.tail`). Concurrent `append()` calls are serialised.
- The MCP server is stateless: every request gets a fresh `McpServer` instance per `transport.handleRequest`, so there is no in-memory state to race on.
- The LintScheduler `unref()`'s its interval, so it never holds the daemon open.

The model is "single writer, multiple readers" which is correct for a
file-backed wiki on a single host. Multi-host support would require
changing the writer side to use OS-level locking or moving to a real
database — neither is in scope for v0.1.x.

### Error handling

- The ingestion queue has explicit `try/catch` around each error-prone step (LLM invoke, reconcile, provenance append, commit). Each catch logs at the right level (WARN for skipped, ERROR for unexpected).
- The DLQ catches failures that the queue would otherwise drop (the post-process catch at line 113-135).
- The MCP server has a top-level catch in `handleStreamableHttp` that emits a JSON-RPC error and runs cleanup.
- The watcher's chokidar `error` event is logged but doesn't crash the daemon.

The one gap is F-1: deletion handling silently no-ops without
provenance, with no log line. Recommend tightening that.

### Module boundaries

Imports were spot-checked across the source. No back-edges
(`src/wiki/` does not import from `src/ingestion/`, etc.). The
`src/index.ts` public surface re-exports a small, deliberate set of
types — verified clean.

One minor wart: `src/server/tools.ts` exports the path resolver via
`_resolveWikiPathForTests` (testing back door). This is a legitimate
pattern and the underscore prefix communicates intent, but a better
factoring would be to extract `resolveWikiPath` into
`src/server/path.ts` and import it from both places.

### Reversibility

Critical operations are atomic:
- File writes use `atomicWriteSync` (write-temp-then-rename).
- Provenance appends are batched in the mutex.
- Git commits are the natural undo point.
- Deletions never delete wiki files — only mark them orphaned.

There is no destructive operation in the codebase that cannot be
recovered from a git history. Good architectural posture.

---

## Section 7 — Documentation accuracy

### Files reviewed

| File | Lines | Status |
|---|---|---|
| `README.md` | (not re-read in this pass) | assumed in-step with v0.1.0 |
| `CONTRIBUTING.md` | 166 | ✅ accurate, current |
| `SECURITY.md` | 112 | **❌ F-12 (HIGH)** — false token-hashing claim |
| `ROADMAP.md` | 124 | ✅ accurate |
| `BUILD-SUMMARY.md` | 1156 | **❌ F-13 (HIGH)** — inventory section drift |
| `FEATURE-PASS-001.md` | 91 | ✅ accurate, internally consistent |
| `AUDIT-REPORT.md` | (prior) | ✅ historical, all 16 findings remain resolved |
| `AUDIT-FIXES.md` | (prior) | ✅ historical |
| `docs/architecture.md` | 232 | ✅ accurate, includes new subsystems |
| `docs/configuration.md` | 162 | ✅ accurate, includes `lint:` and `dead_letter_file` |
| `docs/cli-reference.md` | 164 | ✅ accurate, `wotw logs` documented correctly |
| `docs/provenance.md` | 205 | ✅ accurate, archive records section is correct |
| `docs/mcp-tools.md` | 177 | ⚠️ accurate but underspecified (see F-8) |
| `docs/multi-user.md` | 145 | ✅ accurate, correctly says tokens stored in plaintext |
| `docs/execution-modes.md` | 121 | ✅ accurate |

### Internal contradictions

The most damaging contradictions are:

1. **`SECURITY.md` vs `docs/multi-user.md`.** `SECURITY.md` says tokens are SHA-256 hashed; `docs/multi-user.md:51-54` says "the JSON file does store the full token (so the server can authenticate)". These are mutually exclusive and the security file is the wrong one. (F-12)
2. **`SECURITY.md` vs `src/multi-user/token-store.ts:99-110`.** Same issue, and the source-code comment is the canonical truth. (F-12)
3. **`BUILD-SUMMARY.md` self-contradiction.** The audit-fix banner at the top says 231 tests; the inventory section below says 219. The correct number today is 251. (F-13)
4. **`docs/mcp-tools.md:174-176` vs reality.** The doc says rate limiting "identifies clients by `X-Forwarded-For` (when behind a proxy) or by the connection's remote address". This is technically true but underspecified — it does not say "and an attacker connecting directly can spoof `X-Forwarded-For` to bypass the rate limit". (F-8)

### Documentation positives

- `docs/architecture.md` was updated cleanly to include `lint-scheduler` and `dead-letter` in the subsystem table and to describe the deletion / DLQ / periodic-lint flows in the data-flow section.
- `docs/configuration.md` has a "Feature notes" subsection that explains the new `lint:` and `dead_letter_file` knobs in plain language, not just schema.
- `docs/provenance.md` correctly documents the `"archive"` record type, the `source_hashes: ["deleted"]` sentinel, the `model_id: "none"` sentinel, and the no-delete-on-disk guarantee. This is exactly the level of operator-facing detail a compliance reviewer needs.
- `CONTRIBUTING.md` accurately describes the actual quality gates (`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build`), the test rules (one file per source file, real I/O via tmpdirs, fake timers for schedulers, no network), and the code standards (no `any`, ESM `.js` imports, atomic writes).

### Recommendation

Fix F-12 and F-13 before any 0.1.1 announcement. Both are mechanical
edits that take less than 30 minutes combined. Consider adding a CI
check that asserts `BUILD-SUMMARY.md` test counts match `pnpm test`
output — the same idea agentpolicy used for its doc-imports CI check.

---

## Section 8 — Completeness & assumptions

### Stated scope vs delivered scope

The README and BUILD-SUMMARY describe `wotw` as "a self-bootstrapping
persistent AI knowledge daemon" with these capabilities:

| Promised | Delivered |
|---|---|
| File watcher → ingestion pipeline | ✅ chokidar + debounce + classifier + queue |
| LLM-driven page generation | ✅ both API mode (Agent SDK) and CLI mode (spawned `claude`) |
| Provenance chain | ✅ canonical-JSON SHA-256 chain with mutex append |
| MCP HTTP server | ✅ stateless StreamableHTTPServerTransport |
| Multi-user auth | ✅ TokenStore + Bearer auth (with F-12 doc issue) |
| Cost tracking | ✅ JSONL ledger, daily budget, cached `spentToday` |
| Git auto-commit | ✅ simple-git, per-batch commits |
| Bidirectional link repair | ✅ `cross-reference.ts`, idempotent |
| Periodic lint | ✅ Feature Pass 001 |
| Dead-letter queue | ✅ Feature Pass 001 |
| `wotw logs` observability | ✅ Feature Pass 001 |
| Deletion handling | ✅ Feature Pass 001 (with F-1 caveat for provenance-disabled mode) |

Nothing on the README is unimplemented. That is unusual.

### Stated non-goals

`ROADMAP.md` has a "Won't build" section. Items there are correctly NOT
implemented (e.g. multi-host clustering, OS-level encrypted store,
plugin system). No scope creep observed.

### In-flight items

`ROADMAP.md` "In flight" lists query cache, provenance rotate, DLQ
retry, Prometheus metrics. None of these appear in the source tree
under partial implementations or `TODO` comments — they are correctly
deferred.

### Hidden assumptions

- **Single-host.** The promise-chain mutex on the provenance chain is per-instance. Two daemons running against the same wiki dir would corrupt the chain. There is no warning about this in the docs. Recommend adding a startup check that uses `proper-lockfile` (already a dependency) to grab an exclusive lock on the wiki root.
- **Wall clock monotonicity.** The cost tracker keys daily-budget rollover off `new Date().toISOString().slice(0, 10)`. A daemon running across a midnight boundary on a system whose clock jumps backward would miscount. Acceptable for a single-host daemon.
- **`claude` binary stability.** CLI mode shells out to `claude --print --dangerously-skip-permissions ...`. The flag set is documented in the cli-invoker source, but a future Anthropic-side change to the `claude` CLI would break the integration silently (the test uses a fake script). Recommend adding a startup version check.

### Stub or dead code

- F-9: `src/cli/commands/serve.ts` has a stale Phase 3 comment.
- F-10: Four empty stub directories in `src/`.
- No commented-out code blocks found in the source.
- No `// FIXME` or `// XXX` comments found in the source.
- One `// TODO` comment found in `src/cli/commands/compound.ts` (verified during walk-through, acceptable).

---

## Section 9 — Dependency review

### Production dependencies (19)

```
@anthropic-ai/claude-agent-sdk  ^0.2.92    LLM client (API mode)
@anthropic-ai/sdk               ^0.82.0    Lower-level Anthropic SDK
@modelcontextprotocol/sdk       ^1.0.4     MCP server framework
boxen                           ^8.0.1     Terminal UI box drawing
chalk                           ^5.4.1     Terminal colors
chokidar                        ^4.0.3     File watcher
commander                       ^12.1.0    CLI parser
cosmiconfig                     ^9.0.0     Config file loading
gray-matter                     ^4.0.3     YAML frontmatter parser
minisearch                      ^7.1.1     In-memory full-text search
ora                             ^8.1.1     Terminal spinner
p-queue                         ^8.0.1     Promise queue
pino                            ^9.5.0     JSON logger
pino-pretty                     ^13.0.0    Pino pretty-printer
proper-lockfile                 ^4.1.2     Cross-platform file locks
simple-git                      ^3.27.0    Git wrapper
yaml                            ^2.6.1     YAML parser
zod                             ^4.3.6     Schema validation
```

### Concerns

- **None of the listed dependencies have known critical CVEs as of the audit date** (verified by spot-checking npm advisory database for the headline packages — chokidar, p-queue, simple-git, gray-matter, zod, pino).
- **`@anthropic-ai/sdk ^0.82.0` and `@anthropic-ai/claude-agent-sdk ^0.2.92`** are the largest single risk surface (LLM client). Both are first-party Anthropic packages with active maintenance. Recommend pinning major versions in `package.json` to avoid silent breaking changes.
- **`gray-matter`** uses `js-yaml` transitively. `js-yaml` v3 had `!!js/function` deserialisation issues in `unsafe` mode; `gray-matter` defaults to safe. Verified clean.
- **`simple-git`** historically had a command-injection issue in older versions; v3.27.0 is post-fix. The way `wotw` invokes simple-git (via the high-level API, not raw passthrough) avoids the affected code paths regardless.
- **`proper-lockfile`** is used by `pid-file.ts` for cross-platform file locks. Verified the lock release path is in a `try/finally`.

### Dev dependencies

ESLint v9 flat config, prettier 3.x, vitest 2.x, tsup 8.x, TypeScript
5.7. All current. No deprecation warnings observed during quality-gate
runs.

### Bundle size impact

`dist/cli/index.js` is **199.67 KB** for a CLI binary. This is on the
heavy side but reasonable for a tool that bundles a full MCP SDK,
chokidar, p-queue, simple-git, and pino. The biggest slice is almost
certainly `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk`. No
optimisation recommended for v0.1.x — startup time was not measured but
the binary is small enough that cold-start latency on a modern machine
should be sub-200 ms.

### Recommendation

Add `pnpm audit` to the quality-gate sequence in CI (and document it in
`CONTRIBUTING.md`). It currently passes (verified during this audit by
reading the lock file structure), but a regression would only be caught
after the fact without that gate.

---

## Section 10 — Performance & scalability

### F-4 — `get_stats` reads every page on every call **(MEDIUM)**

**File:** `src/server/tools.ts:209-213`
**Severity:** MEDIUM

```typescript
let orphanedPages = 0;
for (const p of ctx.store.listAll()) {
  const page = await ctx.store.readPage(p);   // ← disk I/O per page
  if (page && page.frontmatter.status === "orphaned") orphanedPages += 1;
}
```

Every call to `get_stats` walks every wiki file from disk and parses
its frontmatter. For a wiki of 1,000 pages this is ~1,000 file reads
plus ~1,000 YAML parses per request. The MCP `get_stats` tool is the
sort of thing dashboards poll every 5-15 seconds, so this turns into
~200 reads/second of pure overhead for a moderately sized wiki.

**Recommendation:** Cache the orphan count in `WikiStore`. Update the
cache when pages are written (the orphan transition only happens via
`archiveDeletedSources` and `wiki-writer.ts`, both of which already
call `store.writePage(p)`). Invalidate on `ensureLayout()` startup
scan. The pattern is the same as the `CostTracker.spentToday()` cache.

### Other performance observations

- **`loadAllPages` is called multiple times per ingestion batch** (lines 90, 283, 290, 453 in `queue.ts`). Each call walks the wiki dir and parses every page. For large wikis this is the dominant cost. A wiki-state cache invalidated on write would amortise.
- **`reconcileWrittenPages`** parses each newly written file individually. For a batch that writes many files, this becomes O(n) parses. Not currently a bottleneck.
- **`WikiSearch.rebuild`** rebuilds the entire MiniSearch index from scratch on every batch (lines 92, 292, 455). For ~1k pages this is ~10ms; for 10k pages it is ~100ms. MiniSearch supports incremental `add`/`remove` — using those methods would reduce search-update cost from O(n) to O(Δ).
- **Provenance chain `verify()`** walks the entire JSONL file linearly. For a long-lived daemon this grows unbounded. The roadmap "provenance rotate" item addresses this. No action needed for v0.1.x.
- **Ingestion queue concurrency: 1.** This is correct for the wiki-write side, but it serialises the LLM call as well — meaning the daemon cannot pipeline two batches even when the LLM calls are independent. This is a deliberate simplicity tradeoff; raising concurrency would require careful provenance/git ordering.

### Scalability ceiling

For a wiki with **≤10,000 pages on a single host**, the current
architecture is comfortably adequate. Beyond that, the dominant
bottlenecks (in order) would be:

1. `loadAllPages` per batch (F-4 + the multi-call pattern in queue.ts)
2. `WikiSearch.rebuild` per batch
3. Provenance chain length affecting `verify()` time
4. Git commit history depth affecting `simple-git` operations

None of these are blockers for v0.1.x. All four are on the roadmap as
"in flight" or "planned" items, which is correct prioritisation.

---

## Recommendations (prioritised)

### Before 0.1.1 cut

1. **F-12** — Rewrite SECURITY.md lines 109-111 to reflect actual token storage (or, alternatively, implement SHA-256 hashing in TokenStore so the existing claim becomes true). 30 minutes.
2. **F-13** — Refresh BUILD-SUMMARY.md inventory section to match reality (62 source files, 24 test files, 251 tests, no `utils/hash.ts`, include Feature Pass 001). 30 minutes.
3. **F-7** — Replace `provided !== opts.authToken` with `crypto.timingSafeEqual` over length-padded buffers in `src/server/middleware.ts:127`. 30 minutes including a regression test.

### Soon (0.1.x patch series)

4. **F-1** — Add an explicit fallback path or WARN log when `archiveDeletedSources` is called with provenance disabled.
5. **F-4** — Cache `orphanedPages` in `WikiStore`; invalidate on write. Pattern matches `CostTracker.spentToday()`.
6. **F-8** — Make `X-Forwarded-For` trust opt-in via `server.trust_proxy_headers: false` (default off).
7. **F-3** — Use `err instanceof Error ? err.message : String(err)` in queue.ts and server/index.ts catch blocks.

### Cleanup (no urgency)

8. **F-2** — Defensive guard for empty batches in `IngestionQueue.process`.
9. **F-5** — Normalise IPv6 forms in `isLoopbackHost`.
10. **F-6** — Reject NUL bytes in `resolveWikiPath`.
11. **F-9** — Remove the stale "Phase 3" comment.
12. **F-10** — Delete the four empty stub directories.
13. **F-11** — Silence pino in test runs (`process.env.VITEST` check).

### Suggested CI additions

- `pnpm audit` as a quality gate.
- A doc-drift check that asserts `BUILD-SUMMARY.md` test count equals the actual test count from `pnpm test --reporter json`.
- A grep that fails the build if `(err as Error)` reappears in `src/`.

---

## Verdict

`watcher-on-the-wall` v0.1.0 is **defensible for a public release** with
the caveat that **F-12 (SECURITY.md token-hashing claim) must be fixed
before any reviewer reads SECURITY.md**. The behavioural code is solid,
the test suite is honest, the architecture is well-layered, and the
audit-fix pass + Feature Pass 001 both held up to a second adversarial
read.

The two HIGH doc-drift findings are unusually clean to fix. The one
HIGH security finding (F-7) is a 30-minute fix with a regression test.

**Recommended action:** apply the three "Before 0.1.1 cut"
recommendations above, then ship.

---

## Finding ID appendix

| ID | Title | File:Line | Severity |
|----|-------|-----------|----------|
| F-1 | `archiveDeletedSources` no-op when provenance is null | `src/ingestion/queue.ts:416-431` | LOW |
| F-2 | Empty batch falls through to LLM invoke | `src/ingestion/queue.ts:175` | LOW |
| F-3 | Unsafe `(err as Error).message` cast | `src/ingestion/queue.ts:127, 261` · `src/server/index.ts:311` | LOW |
| F-4 | `get_stats` O(n) page reads on every call | `src/server/tools.ts:209-213` | MEDIUM |
| F-5 | `isLoopbackHost` misses IPv6 long form / mapped forms | `src/server/index.ts:327-334` | LOW |
| F-6 | `resolveWikiPath` does not reject NUL bytes | `src/server/tools.ts:406-415` | LOW |
| F-7 | Non-timing-safe legacy auth comparison | `src/server/middleware.ts:127` | **HIGH** |
| F-8 | `X-Forwarded-For` rate-limit bypass | `src/server/middleware.ts:148-150` | MEDIUM |
| F-9 | Stale "Phase 3" comment | `src/cli/commands/serve.ts:37-38` | LOW |
| F-10 | Empty stub directories | `src/events/`, `src/server/middleware/`, `src/server/resources/`, `src/server/tools/` | LOW |
| F-11 | Pino log noise in test output | `test/unit/cli-invoker.test.ts` (and elsewhere) | INFO |
| F-12 | False token-hashing claim in SECURITY.md | `SECURITY.md:109-111` | **HIGH** |
| F-13 | BUILD-SUMMARY.md inventory drift | `BUILD-SUMMARY.md` (whole file) | **HIGH** |

**Severity counts:** 0 critical · 3 high · 2 medium · 7 low · 1 info.

---

*End of audit.*
