# SHIP-V0.8.0 — Daemon v0.8.0 Fly Registry Ship

**Status:** ✅ Closed
**Date:** 2026-05-24
**Build commit:** `b1213de64cbe2ee1a928a0232886fc1b59bf2b2f`
**Source commit (Pass B closure):** `99d74abe274181232ffe8c85a13da289f20195ce`
**Image:** `registry.fly.io/wotw-daemon:v0.8.0`

This is the deployment-artifact closure for the v0.8.0 daemon. The feature
closure for Pass B (the v0.8.0 source) is in `CONTEXT-EFFICIENCY-PASS-B.md`;
this file is the ship/registry record that the cloud `FLY_DAEMON_IMAGE` rev
bump consumes.

---

## 1. Preflight verification

All preconditions verified before any mutation.

| Precondition | Result | Evidence |
|---|---|---|
| `package.json` version is `0.8.0` | bumped 0.4.0 → 0.8.0 in commit `b1213de` | `git diff b1213de^..b1213de -- package.json` |
| CLI `--version` surface exists | ✓ wired via Commander in `src/cli/index.ts:46`, reads `VERSION` from `src/utils/version.ts` (`createRequire(package.json)`) | source inspection |
| `flyctl auth whoami` | ✓ `89477141-51d1-51c7-9a40-eb66e268e945@tokens.fly.io` | `flyctl auth whoami` |
| `flyctl auth docker` | ✓ "Authentication successful." | `flyctl auth docker` |
| `docker buildx ls` | ✓ default builder supports `linux/amd64` (matches Fly target) | `docker buildx ls` |
| 7 gates green at HEAD `99d74ab` (pre-bump baseline) | ✓ see §4 | gate logs |

## 2. Build + push

**Command (single shot):**

```
docker buildx build --platform linux/amd64 --progress=plain \
  -t registry.fly.io/wotw-daemon:v0.8.0 --push .
```

**Dockerfile:** `./Dockerfile` (multi-stage: `node:20-slim` build stage →
`node:20-slim` runtime stage; entrypoint `docker/entrypoint.sh`).

**Build stage outcomes:**

- `pnpm install --frozen-lockfile --ignore-scripts` — clean
- `node /app/node_modules/@anthropic-ai/claude-code/install.cjs` — claude
  native binary installed
- `pnpm build` — tsup ESM + DTS build succeeded
- `pnpm prune --prod --ignore-scripts` — dev deps removed

**Runtime stage outcomes:**

- gosu installed, `wotw:wotw` user (uid/gid 1001) created
- `/app/node_modules/.bin/claude --version` → `2.1.138 (Claude Code)` ✓
  (sanity check that native binary survived the multi-stage copy)
- `/app/dist/cli/index.js` symlinked to `/usr/local/bin/wotw`
- `chown -R wotw:wotw /app` applied

**Push outcome:**

```
#26 pushing manifest for registry.fly.io/wotw-daemon:v0.8.0@sha256:4d13f66f756dc0618aafae7d869152570c06490ae1b8d1277184df6f300a52ac
#26 pushing manifest ... done
#26 DONE 121.3s
```

## 3. Manifest digests

Verified via `docker buildx imagetools inspect registry.fly.io/wotw-daemon:v0.8.0`:

| What | Digest | MediaType | Purpose |
|---|---|---|---|
| **OCI image index** (manifest list) | `sha256:4d13f66f756dc0618aafae7d869152570c06490ae1b8d1277184df6f300a52ac` | `application/vnd.oci.image.index.v1+json` | **Pin this in `FLY_DAEMON_IMAGE`** |
| linux/amd64 image manifest | `sha256:9b33b29b96113560dbaed9829e571bd1cda861948840d6af6b9bd7010caf79ff` | `application/vnd.oci.image.manifest.v1+json` | runtime image (resolved from index) |
| Attestation manifest (SBOM/provenance) | `sha256:47f915aedd3e86e3fa576c6a25f8aefad66c377970c0331f3ae2536d12f75c7a` | `application/vnd.oci.image.manifest.v1+json` (attestation) | BuildKit attestation, references amd64 manifest |
| Image config | `sha256:1d3d8cce8eec6414d6dc3f7b3fe3f61a4854150c554650f63da5847e74bbd20d` | — | — |

**Build timestamp:** `2026-05-24T14:45:26Z` (UTC, push completion).

## 4. Gate evidence

All 7 gates run at HEAD `99d74ab` (pre-bump baseline) and again at HEAD
`b1213de` (post-bump). Identical pass count both times.

| Gate | Command | Result |
|---|---|---|
| 1. typecheck | `pnpm typecheck` | ✓ tsc clean |
| 2. lint | `pnpm lint` | ✓ eslint clean |
| 3. format:check | `pnpm format:check` | ✓ "All matched files use Prettier code style!" |
| 4. test | `pnpm test` | ✓ **752 passed (752) — 78 test files, 11.87s duration** |
| 5. build | `pnpm build` | ✓ ESM + DTS build success |
| 6. check-llm-types-sync | `node scripts/check-llm-types-sync.mjs` | ✓ 5783 bytes byte-identical with cloud |
| 7. check-chain-hash-sync | `node scripts/check-chain-hash-sync.mjs` | ✓ 6292 bytes byte-identical with cloud |

Test count `752` replaces the unconfirmed "752" baseline assertion in the
goal directive — it's now verified, not memorized.

## 5. Smoke test (local proxy)

**Scope-limited.** This ship pass validates the source-version surface +
registry artifact integrity. The runtime entrypoint (`wotw-entrypoint` →
env-bridge → `wotw start`) is **not exercised in this pass**. See §6.

**Invocation:**

```
node dist/cli/index.js --version
```

**Output:**

```
0.8.0
exit=0
```

**What this proves:**

- The compiled `dist/cli/index.js` (which is the binary symlinked at
  `/usr/local/bin/wotw` inside the v0.8.0 image) reports the v0.8.0 version
  string, sourced from `package.json` at runtime via `createRequire`.
- Since the same `dist/` is what the Dockerfile copies into the runtime
  stage, the image-side `wotw --version` will report identically.

**Registry-side smoke (manifest integrity):**

`docker buildx imagetools inspect registry.fly.io/wotw-daemon:v0.8.0`
returned a well-formed OCI image index with linux/amd64 + attestation
manifests pointing to valid layers. No drift between local build output
and the pushed registry contents.

## 6. Scope limits (runtime exercise deferred)

**Not performed in this pass:**

- `docker run` of the v0.8.0 image exercising the `wotw-entrypoint` script
  (the script expects `TENANT_ID`, `WIKI_ROOT`, `ADMIN_SERVICE_KEY`,
  `ANTHROPIC_API_KEY` and bridges them into a `wotw.yaml` before exec'ing
  `wotw start`). This is a real per-tenant boot sequence and requires
  hand-fed env vars to behave correctly.
- Fly Machine spawn from the v0.8.0 image.
- End-to-end query of facts.db / `query_facts` MCP tool against a running
  daemon.

**Where the gap is closed:**

The first real runtime exercise of the v0.8.0 image happens at the next
cloud-side per-tenant Fly Machine spawn, after the cloud `/goal` consumes
this digest and bumps `FLY_DAEMON_IMAGE`. If the runtime sees any
regression vs. the v0.7.0 image, the cloud-side rollback path is the
existing v0.7.0 digest (whichever it was — captured by the previous
`SHIP` doc or by `flyctl image show --app wotw-daemon` history).

This scope limit is documented in `CONTEXT-EFFICIENCY-PASS-B.md`
§"Runtime-exercise residual (deferred to first cloud-side spawn)".

## 7. Handoff to cloud

The cloud-side `/goal` that consumes this ship doc fires:

```
flyctl secrets set FLY_DAEMON_IMAGE=registry.fly.io/wotw-daemon@sha256:4d13f66f756dc0618aafae7d869152570c06490ae1b8d1277184df6f300a52ac
```

…against the cloud orchestrator app (whichever app owns the per-tenant
daemon spawn). After the secret update, all subsequent `machines/create`
calls pin to this digest. Existing machines continue running their
existing image until restart.

**The digest to pin is the OCI image index** (`4d13f66f...`), not the
per-platform manifest. The index is what Fly's runtime resolves to the
correct platform image (linux/amd64 in our case).

## 8. Next pass

Per project memory `[[project-wotw-v0-8-0]]` and `CONTEXT-EFFICIENCY-PASS-B.md`
§7, the recommended next product step is **Compliance tier** — builds on
G5 scaffolding (`1875925`), unblocks higher-end pricing, prerequisite for
the Pack layer that comes after.

Separately, **v0.9.0 emit_event** (Maestro Phase 3 integration) is the
next deployment-affecting daemon work. That pass ships its own
`SHIP-V0.9.0.md` and its own image to `registry.fly.io/wotw-daemon:v0.9.0`.

---

**Authority:** Build commit `b1213de` on `main`. Image push verified by
local `docker buildx imagetools inspect` against the pushed tag. Gate
evidence captured at HEAD `99d74ab` (pre-bump) and HEAD `b1213de`
(post-bump) and again post-closure-docs (see commit log).
