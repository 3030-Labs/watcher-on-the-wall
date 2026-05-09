# Fly Migration — Pass 006: Daemon cleanup

**Date:** 2026-04-24
**Base:** wotw v0.2.0 (post Hosted Mode + Launch Prep)
**Companion repo:** `wotw-cloud` (see its `FLY-MIGRATION-PASS-006.md` for the
companion `daemon-host/start.sh` validation hardening)

---

## Summary

Native env-override support for hosted-mode settings, plus runtime
validation that the daemon refuses to start in hosted mode without
`TENANT_ID`, `ANTHROPIC_API_KEY`, and `WIKI_ROOT`. The shared
multi-tenant code (`TenantScheduler`, `TenantFs`, quota counters) is
untouched — it still works in single-tenant mode (one subqueue per
container) and remains correct for any future shared-daemon use case.

## Files modified

| File | Change |
|------|--------|
| `src/daemon/config.ts` | New `applyEnvOverrides(config)` reads `WOTW_HOSTED`, `TENANT_ID`, `WIKI_ROOT`, `WOTW_PORT/HOST/LOG_LEVEL/RUNTIME_MODE/PLAN/TIMEZONE`, and `ADMIN_SERVICE_KEY` and overlays them on the parsed config. New `validateHostedConfig(config)` throws when hosted mode is missing required fields or `tenant_id` is not a UUID. Both wired into `loadConfig`. |
| `docker/entrypoint.sh` | Simplified — no longer writes a runtime `wotw.yaml`. Just preflights env, ensures the wiki root exists/is-writable, then `exec`s `wotw start --foreground`. |
| `test/unit/config.test.ts` | +15 tests covering `applyEnvOverrides` (10) and `validateHostedConfig` (5). |

## Files unchanged (deliberately)

| File | Why preserved |
|------|---------------|
| `src/ingestion/queue.ts` | TenantScheduler activates only when `hosted.enabled && hosted.tenant_id` and is correct with one subqueue. No change needed for per-tenant container mode. |
| `src/ingestion/tenant-scheduler.ts` | Same. Multi-tenant code stays for future flexibility. |
| `src/hosted/tenant-fs.ts` | Symlink rejection + tenant-root containment are still both useful in single-tenant containers (defense in depth). The cross-tenant containment check is a no-op when there's only one tenant. |
| `src/hosted/storage-accountant.ts` | Defense in depth. Cloud enforces quotas, daemon double-checks. |
| `src/hosted/daily-import-counter.ts` | Same. |
| `src/hosted/heal-cooldown.ts` | Same. |

## Resolution order

`loadConfig` now resolves config in this order (highest to lowest priority):

1. **Environment variables** — via `applyEnvOverrides`. New for Pass 006.
2. **User config file** — cosmiconfig discovery (`wotw.config.yaml`, etc).
3. **Defaults** — `defaultConfig()`.

After merge, `validateConfig` (Zod schema) runs as before, then
`validateHostedConfig` runs the hosted-mode runtime checks.

## Hosted-mode invariants

`validateHostedConfig(config)` throws when:

- `hosted.enabled` is true but `hosted.tenant_id` is null or empty.
- `hosted.tenant_id` is set but doesn't match the UUID regex.
- `hosted.enabled` is true but `wiki_root` is empty.

Community-mode configs (`hosted.enabled: false`) are unaffected. The
existing 477 community-mode tests pass unchanged.

## Test summary

| File | Was | Now |
|------|-----|-----|
| `test/unit/config.test.ts` | 21 tests | 36 tests (+10 env override, +5 hosted validation) |
| Whole suite | 492 tests | 507 tests |

## Gates

| Gate | Result |
|------|--------|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm format:check` | clean (after `pnpm format`) |
| `pnpm test` | 507/507 pass |
| `pnpm build` | clean (CLI 317.98 KB) |

## Companion: daemon-host/start.sh hardening (wotw-cloud)

The Railway daemon-host's `start.sh` now performs the same preflight as
the wotw repo's entrypoint: TENANT_ID present, UUID-formatted,
ANTHROPIC_API_KEY set, WIKI_ROOT writable. Catches mis-configured
deploys early.

The Railway daemon-host service stays online until Pass 007's deprecation
gate. Until then, the same runtime safety rails apply on both
deployments.

## What's next

Pass 007: end-to-end testing on Fly, pricing updates ($20 / $29.99),
marketing site changes, Railway daemon-host deprecation.
