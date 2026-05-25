# SHIP-V0.8.2 — Daemon v0.8.2 Image Ship (G5 Closure)

**Status:** ✅ Closed
**Date:** 2026-05-25
**Source HEAD (Pass 018 closure):** `fb19cdb05a8017dbc0086d5fb4cd4808a46d61d1`
**Tag:** `v0.8.2` (annotated, see `git tag -v v0.8.2`)
**Image:** `registry.fly.io/wotw-daemon:v0.8.2`

This is the deployment-artifact closure for the v0.8.2 daemon. The feature
closure for Pass 018 (G5 end-to-end attestation substrate) is in
`PASS-018-G5-CLOSURE.md`; this file is the registry record that the cloud
`FLY_DAEMON_IMAGE` rev bump consumes. Part A of the PASS-019 directive.

---

## 1. Preflight verification

| Precondition | Result | Evidence |
|---|---|---|
| HEAD = `fb19cdb` or v0.8.2 ancestor | ✓ | `git rev-parse HEAD` matched the Pass 018 closure |
| Tag `v0.8.2` exists | ✓ | `git tag --list 'v0.*'` includes `v0.8.2` |
| `package.json` version is `0.8.2` | ✓ | line 3 of package.json |
| Dockerfile retains `pnpm rebuild better-sqlite3` (v0.8.1 fix) | ✓ | line 76 |
| Dockerfile retains build-time SQL self-test gate (v0.8.1 canon) | ✓ | line 123 — `RUN node -e '<DDL+DML+SELECT>'` |
| 7 daemon gates green at HEAD | ✓ | typecheck/lint/format:check/build clean; `pnpm test` 813 passed; sync gates byte-identical |
| `flyctl auth docker` registered | ✓ | "Authentication successful." |
| Docker WSL integration on | ✓ | `docker --version` returned 29.4.2 |

No Dockerfile modifications in this pass — the v0.8.1 native-dep pattern
(`[[feedback-native-dep-dockerfile]]`) is the standing canon and was
preserved.

## 2. Build + push

**Command:**

```
docker buildx build --platform linux/amd64 --progress=plain \
  -t registry.fly.io/wotw-daemon:v0.8.2 --push .
```

**Build-time gates fired (all passed):**

- `pnpm rebuild better-sqlite3` (build stage) → `prebuild-install` fell
  through to `node-gyp` and compiled from source under the python3 +
  make + g++ toolchain (canon as of v0.8.1, commit `7c7ca84`).
- `RUN /app/node_modules/.bin/claude --version` (runtime stage) →
  `2.1.138 (Claude Code)`.
- `RUN node -e '<better-sqlite3 SQL exercise>'` (runtime stage) →
  `better-sqlite3 self-test passed`. Image build refuses to push if
  the bindings can't load (the v0.8.1 standing pattern that prevents
  v0.8.0-class regressions).

**Push outcome:**

First push attempt hit the same WSL vsock credential-helper blip that
fired during v0.8.1 ship (`error getting credentials - err: exit
status 1`). Refreshed `flyctl auth docker` and retried (non-destructive
— buildx layer cache was warm). Second push completed in ~37s.

## 3. Manifest digests

Verified via `docker buildx imagetools inspect registry.fly.io/wotw-daemon:v0.8.2`:

| What | Digest | MediaType | Purpose |
|---|---|---|---|
| **OCI image index** (manifest list) | `sha256:a40b1619f5cd8978169b2c738f305b8e31f09c0aa944b30d2c7be4a6ac4a6012` | `application/vnd.oci.image.index.v1+json` | **Pin this in `FLY_DAEMON_IMAGE`** |
| linux/amd64 image manifest | `sha256:72d91ed2d0cc7497c05e2eada1836fe8d6c38ceac71b906ef5a6ee28723298ee` | `application/vnd.oci.image.manifest.v1+json` | runtime image |
| Attestation manifest (SBOM/provenance) | `sha256:dbe41deb46a0770626bcc25effaa5128f76b9ea0cc476f858a341a8a1c396bce` | attestation | BuildKit attestation |
| Image config | `sha256:eed9bca7c1d8b660ae07a7d6dcecba2de0af61cbb7989a2ee2f18c166a24336a` | — | — |

**Build timestamp:** 2026-05-25T02:54:00Z (push completion).

## 4. Artifact verification

### `.node` binding present

```
$ docker run --rm registry.fly.io/wotw-daemon:v0.8.2 find /app -path '*better_sqlite3.node*'
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/better_sqlite3.node.d
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/.deps/Release/better_sqlite3.node.d
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.node
```

The compiled .node lives at the expected path (`build/Release/`). The
v0.8.0-class bug (entire `build/` directory missing) cannot recur
under the v0.8.1 build-time gate.

### Boot smoke (real container, real `/healthz`)

This is **scope-expanded** vs. v0.8.0/v0.8.1 ships — those deferred
runtime entrypoint exercise to first cloud-side tenant spawn. v0.8.2
spawns a throwaway container locally and confirms the daemon listens
and reports the right version.

```
$ docker run -d \
    -e TENANT_ID=89a8e0b6-9641-4576-84a6-7663e8f38364 \
    -e ANTHROPIC_API_KEY=sk-test-fake-not-real \
    -e WIKI_ROOT=/data/smoke \
    -e ADMIN_SERVICE_KEY=smoke-admin \
    -e WOTW_HOST=0.0.0.0 \
    -p 13030:3000 \
    --name wotw-smoke \
    registry.fly.io/wotw-daemon:v0.8.2

$ curl -sf -m 2 http://127.0.0.1:13030/healthz
{"ok":true,"name":"watcher-on-the-wall","version":"0.8.2"}

# Boot-to-healthy: 4 seconds (well under the 60s budget).
# Deprovision:
$ docker stop wotw-smoke && docker rm wotw-smoke
```

Findings from the boot smoke (worth noting for the next pass):

- `TENANT_ID` is validated as a UUID by the daemon config loader
  (`validateHostedConfig` in `src/daemon/config.ts`). An invalid value
  fails the daemon at init with `Config error: hosted.tenant_id is
  not a valid UUID`. The cloud orchestrator already injects real
  tenant UUIDs at spawn, so this only affects manual smoke tests —
  documented here so future smoke flows generate UUIDs via
  `uuidgen` or equivalent.
- When the daemon fails at init, the error lands in the fallback
  logger at `/tmp/wotw/daemon.log` (per
  `src/daemon/entry.ts:31-48`). Docker's stdout/stderr stream only
  shows the early `console.log` from config-loader; deeper init
  failures are file-only. Useful for diagnosing future boot issues:
  `docker exec <container> cat /tmp/wotw/daemon.log`.

### What the boot smoke covers vs. defers

| Covered (this pass) | Deferred (cloud-side spawn) |
|---|---|
| Container starts under entrypoint script | Per-tenant Fly Machine cold-start performance |
| `node /app/dist/daemon/entry.js` reaches MCP HTTP server | Cloud-orchestrator-injected env (real `ANTHROPIC_API_KEY`, `ADMIN_SERVICE_KEY`, `WOTW_WORKSPACE_KEK`) |
| McpHttpServer binds port 3000 | First real ingestion / `query_facts` round-trip |
| `/healthz` returns 200 with version `0.8.2` | Provenance chain + G5 KeyStore actually attesting under a real KEK |
| .node artifact loads (FactStore would not crash) | Tenant data round-trip through facts.db + minisearch |

The G5 KeyStore is **opt-in**: requires `WOTW_WORKSPACE_KEK` in env.
The smoke does not set it, so the daemon falls back to the v0.8.1
single-key 4-tier resolution. First real KeyStore exercise happens at
the first cloud-side tenant spawn against v0.8.2 that has the
`WOTW_WORKSPACE_KEK` Fly secret populated.

## 5. Gate evidence

All 7 daemon gates re-run at HEAD `fb19cdb` (this pass introduced no
source changes; the image was built from the same commit Pass 018
closed at).

| Gate | Command | Result |
|---|---|---|
| 1. typecheck | `pnpm typecheck` | ✓ |
| 2. lint | `pnpm lint` | ✓ (0 errors, 0 warnings) |
| 3. format:check | `pnpm format:check` | ✓ |
| 4. test | `pnpm test` | ✓ **813 passed (813)** across 83 files |
| 5. build | `pnpm build` | ✓ |
| 6. check-llm-types-sync | `node scripts/check-llm-types-sync.mjs` | ✓ 5783 bytes byte-identical |
| 7. check-chain-hash-sync | `node scripts/check-chain-hash-sync.mjs` | ✓ 6292 bytes byte-identical |

## 6. Handoff to cloud

The cloud-side `/goal` that consumes this ship doc fires:

```
flyctl secrets set FLY_DAEMON_IMAGE=registry.fly.io/wotw-daemon@sha256:a40b1619f5cd8978169b2c738f305b8e31f09c0aa944b30d2c7be4a6ac4a6012 --app <wotw-cloud-orchestrator-app>
```

…replacing the v0.8.1 digest (`sha256:f62d153f...`). After secret
update, all subsequent `machines/create` calls pin to v0.8.2. Existing
machines on v0.8.1 continue running until restart.

**G5 activation (cloud-side)**: v0.8.2 daemons spawn with G5 attestation
ACTIVE only when `WOTW_WORKSPACE_KEK` is in the per-tenant env. Cloud
orchestrator should:

1. Generate a 32-byte CSPRNG KEK per tenant out-of-band, base64-encode.
2. Set `WOTW_WORKSPACE_KEK=<value>` in the per-tenant Fly secrets
   alongside the existing per-tenant secrets (ANTHROPIC_API_KEY,
   ADMIN_SERVICE_KEY, etc.).
3. Spawn / restart the machine. Daemon's first boot under v0.8.2 +
   KEK provisions an active DEK at `.wotw/keys.db` and starts
   stamping `key_id` on every chain append.

If `WOTW_WORKSPACE_KEK` is not set in env, v0.8.2 daemons fall back to
the v0.8.1 single-key 4-tier HMAC resolution — chains continue to
verify identically under the older daemons.

**Rollback path**: if v0.8.2 surfaces a regression, cloud pins back to
the v0.8.1 OCI index digest
`sha256:f62d153fd598d68b8651aba5ca62180e6d7e229d39556b0fb2b7ecbda7a68d05`.
Chains attested under v0.8.2 (carrying `key_id`) still verify under
v0.8.1 via the canonical-payload-exclusion pattern — v0.8.1 verify
doesn't recompute HMAC, so the extra fields are JSON noise to it.

## 7. What's next

This ship doc closes Part A of the PASS-019 /goal directive. Parts
B (KEK rotation operation + CLI + tests + runbook) and C (auto-archive
cron + tests) continue in the same /goal; if both land, the final
deliverable is a follow-on v0.8.3 image with a parallel
`SHIP-V0.8.3.md` ship doc.

---

**Authority:** Image push verified via `docker buildx imagetools
inspect` against the pushed tag. Boot smoke verified via direct
`docker run` + `curl /healthz` against the throwaway container. Gate
evidence captured at HEAD `fb19cdb`.
