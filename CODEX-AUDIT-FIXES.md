# Codex Audit — Fix Pass

**Date:** 2026-04-10
**Source:** External Codex audit of v0.2.0 codebase
**Findings:** 3 (1 medium, 1 low, 1 operational)
**Outcome:** All 3 findings resolved. All 5 quality gates green.
**Tests:** 356 → 359 (+3) across 37 → 38 (+1) files.

---

## 1. Summary table

| #  | Severity    | Title                                          | Status   | Files touched |
|----|-------------|------------------------------------------------|----------|---------------|
| 1  | Low         | Version string drift (`0.1.0` hardcoded)       | ✅ Fixed | `src/utils/version.ts` (NEW), `src/server/index.ts`, `src/cli/index.ts`, `src/cli/commands/lib/mcp-client.ts`, `src/daemon/index.ts`, `test/unit/version.test.ts` (NEW) |
| 2  | Medium      | `TokenStore.load()` crash on malformed JSON    | ✅ Fixed | `src/multi-user/token-store.ts`, `test/unit/token-store.test.ts` |
| 3  | Operational | No `pnpm audit` in CI                          | ✅ Fixed | `.github/workflows/ci.yml` |

---

## 2. Fix 1 — Version string drift

### Problem

`package.json` declared version `0.2.0`, but four source files still
hardcoded `"0.1.0"`:

- `src/server/index.ts` — `/healthz` response and MCP `serverInfo`
- `src/cli/commands/lib/mcp-client.ts` — MCP client identity
- `src/daemon/index.ts` — PID file metadata

Additionally, `src/cli/index.ts` had a local `const VERSION = "0.2.0"`
that would need manual updating on every version bump.

### Fix

Created `src/utils/version.ts` — a single source of truth that reads
`version` from `package.json` at runtime via `createRequire`. This can
never drift because it reads the actual `package.json` file.

```typescript
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };
export const VERSION: string = pkg.version;
```

All 5 consumer files now import `VERSION` from this utility. The local
`const VERSION = "0.2.0"` in `src/cli/index.ts` was replaced with the
import.

### Regression test

`test/unit/version.test.ts` (2 tests):
- Asserts `VERSION` matches `package.json` (read independently via
  `createRequire`)
- Asserts the value looks like a semver string

### Verification

```
grep -r '"0\.1\.0"' src/  →  zero matches
```

---

## 3. Fix 2 — TokenStore corrupt JSON crash

### Problem

`TokenStore.load()` called `JSON.parse()` on the raw file contents
without a try/catch. A truncated or corrupt `tokens.json` (disk error,
partial write recovery, manual edit) would throw an unhandled error and
could abort daemon startup when `multi_user.enabled: true`.

### Fix

Wrapped the `JSON.parse()` call in `load()` with a try/catch that falls
back to an empty token map. The corrupt file is preserved on disk for
manual recovery — we never delete it.

```typescript
let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch {
  // Corrupt or truncated file — fall back to empty store.
  this.tokens = new Map();
  return;
}
```

### Regression test

Added 1 test to the existing `test/unit/token-store.test.ts`:
- Writes `"not json {{{"` to the token file
- Calls `store.load()` — asserts no throw
- Asserts `store.size() === 0`
- Asserts the corrupt file still exists on disk

The existing test "handles malformed JSON structure gracefully" already
covered valid-JSON-but-wrong-shape. The new test covers unparseable JSON.

---

## 4. Fix 3 — pnpm audit in CI

### Problem

The Codex audit tried `npm audit` and got `ENOLOCK` because the project
uses pnpm. There was no dependency vulnerability check in CI.

### Fix

Added a `pnpm audit --prod` step to `.github/workflows/ci.yml` after
`pnpm install`, before the quality gates.

The step is non-blocking (`|| true`) because all 6 current advisories
are transitive dependencies with no direct fix available:

| Advisory | Package | Via | Severity |
|----------|---------|-----|----------|
| GHSA-5474-4w2j-mq4c | `@anthropic-ai/sdk` | `@anthropic-ai/claude-agent-sdk` | moderate |
| GHSA-26pp-8wgv-hjvm | `hono` | `@modelcontextprotocol/sdk` | moderate |
| GHSA-r5rp-j6wh-rvv4 | `hono` | `@modelcontextprotocol/sdk` | moderate |
| GHSA-xpcf-pg52-r92g | `hono` | `@modelcontextprotocol/sdk` | moderate |
| GHSA-xf4j-xp2r-rqqx | `hono` | `@modelcontextprotocol/sdk` | moderate |
| GHSA-wmmm-f939-6g9c | `hono` | `@modelcontextprotocol/sdk` | moderate |

All are in upstream SDK packages. When those packages release patched
versions, `pnpm update` will resolve the advisories and the CI step
can be made blocking.

---

## 5. Gate results

```
pnpm typecheck    → clean (0 errors)
pnpm lint         → clean (0 errors)
pnpm format:check → clean (0 diffs)
pnpm test         → 359/359 passing across 38 files
pnpm build        → ESM + DTS success
                    dist/cli/index.js     273.12 KB
                    dist/daemon/entry.js  178.93 KB
                    dist/index.js          24.88 KB
pnpm audit --prod → 6 moderate (all transitive, no fix)
```

---

## 6. Files changed

### New files
- `src/utils/version.ts` — version utility (14 LoC)
- `test/unit/version.test.ts` — version drift guard (2 tests)

### Modified source files
- `src/server/index.ts` — replaced 2× `"0.1.0"` with `VERSION` import
- `src/cli/index.ts` — replaced local `const VERSION` with import
- `src/cli/commands/lib/mcp-client.ts` — replaced `"0.1.0"` with `VERSION` import
- `src/daemon/index.ts` — replaced `"0.1.0"` with `VERSION` import
- `src/multi-user/token-store.ts` — `JSON.parse` try/catch guard

### Modified test files
- `test/unit/token-store.test.ts` — +1 test (corrupt JSON)

### Modified config/CI
- `.github/workflows/ci.yml` — added `pnpm audit --prod || true` step
- `BUILD-SUMMARY.md` — updated headline numbers, added Gate 13
