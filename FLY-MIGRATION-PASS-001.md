# Fly Migration — Pass 001: Daemon Dockerfile + Fly app setup

**Date:** 2026-04-24
**Base:** v0.2.0 (post Hosted Mode + Launch Prep)
**Companion repo:** `wotw-cloud` (see its `FLY-MIGRATION-PASS-001.md`)

---

## Summary

This pass produces a runnable wotw daemon image suitable for per-tenant Fly
Machine deployment. No source changes — the daemon's build, lint, tests,
and runtime behavior are identical to v0.2.0. The only additions are the
container packaging needed for the Fly Migration described in
`wotw-master-checklist.md` and the migration plan handoff.

## Files added

| File | Purpose |
|------|---------|
| `Dockerfile` | Multi-stage Node 20 image. Builds TypeScript -> `dist/`, prunes dev deps, copies the entrypoint, and exposes port 3000. |
| `docker/entrypoint.sh` | Bridges container env vars (`TENANT_ID`, `ANTHROPIC_API_KEY`, `WIKI_ROOT`, `ADMIN_SERVICE_KEY`, `WOTW_*`) into a runtime-generated `wotw.yaml` under `WIKI_ROOT`, then `exec`s `wotw start --foreground`. |
| `.dockerignore` | Excludes `node_modules`, `dist`, tests, audit/build markdown, and `.husky/` from the build context. |

## Why an entrypoint shim instead of native env support

The daemon discovers config via cosmiconfig (`wotw.config.yaml`, `.wotwrc`,
package.json `wotw` key). It does not currently bridge `WOTW_HOSTED` /
`WOTW_TENANT_ID` env vars into `config.hosted.*`. Pass 006 adds first-class
env-override support; until then, `docker/entrypoint.sh` writes a
`wotw.yaml` under `WIKI_ROOT` from env vars and `cd`s there before
`wotw start --foreground` so cosmiconfig picks it up.

The shim is pure shell, runs once at container boot, and produces a config
that the daemon validates through its existing Zod schema. No source code
in `src/` was changed.

## Required env (when `WOTW_HOSTED=true`)

| Var | Notes |
|-----|-------|
| `TENANT_ID` | Becomes `hosted.tenant_id`. Validated as non-empty by the entrypoint; UUID validation lands in Pass 006. |
| `ANTHROPIC_API_KEY` | The user's BYOK key, decrypted at spawn time by the orchestrator (Pass 003). The daemon's existing dual-mode runtime (`api`/`cli`/`auto`) reads it via the SDK. |
| `WIKI_ROOT` | Absolute path under `/data` (e.g. `/data/<tenant_id>`). The mounted Fly volume. |
| `ADMIN_SERVICE_KEY` | Sets `server.auth_token` so the cloud control plane can hit `/mcp` and `/internal/*`. Required when `WOTW_HOST` is non-loopback (the M-SEC-2 safety rail rejects no-auth + non-loopback). |

## Optional env

| Var | Default |
|-----|---------|
| `WOTW_HOSTED` | `true` |
| `WOTW_PLAN` | `pro` |
| `WOTW_TIMEZONE` | `America/New_York` |
| `WOTW_PORT` | `3000` |
| `WOTW_HOST` | `0.0.0.0` |
| `WOTW_RUNTIME_MODE` | `api` |
| `WOTW_LOG_LEVEL` | `info` |

## Five gates

| Gate | Result |
|------|--------|
| `pnpm typecheck` | clean |
| `pnpm lint` | clean |
| `pnpm format:check` | clean |
| `pnpm test` | 492/492 pass (55 files) |
| `pnpm build` | clean (CLI 315.69 KB, daemon entry 217.62 KB) |

## Acceptance for Pass 001

The Pass 001 gate is "the daemon runs in Fly when manually spawned." The
Dockerfile and entrypoint are the daemon-side artifacts that make that
possible. The actual `flyctl deploy` smoke test runs from the wotw-cloud
side and is documented in `wotw-cloud/fly/README.md`.

## What's next

- **Pass 002:** programmatic provisioning via the Fly Machines REST API
  from `wotw-cloud/web/lib/fly/`.
- **Pass 006:** first-class env-override support in `src/daemon/config.ts`
  so the entrypoint shim can be retired.
