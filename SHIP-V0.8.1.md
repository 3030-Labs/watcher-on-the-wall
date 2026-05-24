# SHIP-V0.8.1 — Daemon v0.8.1 Patch Ship (better-sqlite3 .node fix)

**Status:** ✅ Closed
**Date:** 2026-05-24
**Ship HEAD:** `7c7ca8488...` (`fix(docker): add python3+make+g++ to build stage`)
**Build commits:**
- `e4d22ad` — `fix(docker): rebuild better-sqlite3 native binding in image (v0.8.1)`
- `7c7ca84` — `fix(docker): add python3+make+g++ to build stage for node-gyp fallback`
**Source HEAD (Pass B closure, unchanged):** `99d74ab`
**Image:** `registry.fly.io/wotw-daemon:v0.8.1`

This is a patch ship correcting a production-blocking bug in v0.8.0
(`sha256:4d13f66f756dc0618aafae7d869152570c06490ae1b8d1277184df6f300a52ac`).
Source code is byte-identical to v0.8.0 — the fix is entirely in the
build infrastructure (Dockerfile + package.json version).

---

## 1. Root-cause analysis

### Symptom

`v0.8.0` (digest `sha256:4d13f66f...`) booted past the daemon banner,
then crashed FATAL on the `FactStore` constructor at module-load time
with "Could not locate the bindings file." Tenant boot fully blocked.

### Diagnosis (Step 1 of this pass)

`docker run --rm registry.fly.io/wotw-daemon:v0.8.0 find /app -path
'*better-sqlite3*'` returned the package source tree
(`deps/`, `src/`, `lib/`, `package.json`) but **no `build/` directory at
all**. The compiled `build/Release/better_sqlite3.node` artifact was
absent from the image.

Local comparison:

| Location | `build/Release/better_sqlite3.node` |
|---|---|
| Host `node_modules/.pnpm/better-sqlite3@12.10.0/.../better-sqlite3/build/Release/` | ✓ present |
| v0.8.0 image same path | ✗ no `build/` directory |

### Root cause

The Dockerfile's build stage runs
`pnpm install --frozen-lockfile --ignore-scripts`. The `--ignore-scripts`
flag is needed to bypass husky's `prepare` lifecycle (which requires a
git repo not present in the build context). It also disables ALL
install-time scripts — including better-sqlite3's
`install: prebuild-install || node-gyp rebuild --release`.

The Dockerfile already had explicit handling for one native dep —
`@anthropic-ai/claude-code`'s `install.cjs` (Pass 009 fix, instance #9).
better-sqlite3 was added in Pass B (v0.8.0 feature work, commit
`99d74ab`) **without an analogous explicit rebuild step**. The source
tree shipped fine (`COPY . .` + the pnpm `node_modules`-layer copy
included the .pnpm subtree) but the `.node` binary — output of the
skipped install script — was never produced.

This is consistent with the [[feedback-irreducibly-external]] +
runtime-exercise residual scope-limit documented in
`CONTEXT-EFFICIENCY-PASS-B.md` §"Runtime-exercise residual (deferred
to first cloud-side spawn)": the v0.8.0 ship's smoke was local-proxy
only (`node dist/cli/index.js --version`) and would never have caught
a missing native binding in the container. The first cloud-side
tenant spawn WAS the gap-closer — and it caught the bug. The cost
was one bad tenant boot.

### Fix

**Dockerfile changes** (two commits, `e4d22ad` + `7c7ca84`):

1. **Build-stage native toolchain.** Added `python3 make g++` to the
   build stage's `apt-get install`. node-gyp's fallback compile path
   needs these; prebuild-install's prebuilt fetch turned out to be a
   no-match on the current node 20.20.2 (`libc=` empty in the target
   mismatched the published prebuilds). The toolchain stays in the
   build stage only — runtime image is unaffected. ~100MB build-cache
   cost, 0 runtime cost.

2. **Build-stage rebuild step.** Added
   `RUN pnpm rebuild better-sqlite3` after the existing
   `pnpm install --ignore-scripts`. `rebuild` invokes the package's
   install script regardless of the `--ignore-scripts` flag and
   regardless of the `pnpm.onlyBuiltDependencies` allowlist (allowlist
   gates install-time; rebuild is explicit).

3. **Runtime-stage build-time gate.** Added a final RUN in the runtime
   stage that exercises better-sqlite3 end-to-end:

   ```
   RUN node -e 'const db = new (require("better-sqlite3"))(":memory:");
        db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);");
        const row = db.prepare("SELECT x FROM t").get();
        if (row.x !== 1) { throw new Error(...); }
        console.log("better-sqlite3 self-test passed");'
   ```

   If the bindings can't load or the addon is broken at any point in
   the open → DDL → DML → SELECT chain, this RUN exits non-zero and
   the image build fails BEFORE the push step. **This class of bug
   is now build-time gated for all future ships.**

### Class-level lesson

The v0.8.0 ship pass scope-limited smoke to local-proxy only. That
scope-limit was honest (documented in `CONTEXT-EFFICIENCY-PASS-B.md`
§"Runtime-exercise residual"), but the gap-closer was "first
cloud-side spawn" — which is too late: a real tenant boot failure.

**v0.8.1 closes the gap inside the ship pass itself** by exercising
the native binding at image-build time. Any future native dep added
to the daemon must either ship a prebuilt in its package OR get an
explicit rebuild step + a corresponding runtime-stage smoke step.
This is now the standing pattern, not a one-off.

## 2. Build + push

### First attempt (commit `e4d22ad`)

Initial fix added `RUN pnpm rebuild better-sqlite3` but assumed
prebuild-install would succeed via prebuilt download (no toolchain
needed). In practice, prebuild-install on node:20-slim's current node
20.20.2 reported `No prebuilt binaries found (target=20.20.2
runtime=node arch=x64 libc= platform=linux)` and fell through to
node-gyp, which then errored on missing Python (`gyp ERR! find Python`).

**Build failed at step `RUN pnpm rebuild better-sqlite3`.** No image
produced. Logged the iteration honestly rather than amending — see
commit `7c7ca84` for the toolchain follow-on.

### Second attempt (commit `7c7ca84`)

Added `python3 make g++` to the build stage's apt-get. Build now
succeeds:

- `pnpm rebuild better-sqlite3` step output:
  - `prebuild-install warn install No prebuilt binaries found` (expected)
  - `gyp info ... node@20.20.2 | linux | x64`
  - `gyp info ok` (toolchain present, build succeeded)
- Runtime-stage `RUN node -e '...'` SQL exercise output:
  - `better-sqlite3 self-test passed`

### Push

First push attempt failed at the credentials-store step
(`error getting credentials - err: exit status 1`, likely transient
WSL vsock blip dropping the docker credential helper). Refreshed via
`flyctl auth docker` and retried (non-destructive — build was fully
cached). Push then completed in ~26s.

**Final push log:**

```
#28 pushing manifest for registry.fly.io/wotw-daemon:v0.8.1@sha256:f62d153fd598d68b8651aba5ca62180e6d7e229d39556b0fb2b7ecbda7a68d05
#28 pushing manifest ... done
#28 DONE 25.9s
```

## 3. Manifest digests

Verified via `docker buildx imagetools inspect registry.fly.io/wotw-daemon:v0.8.1`:

| What | Digest | MediaType | Purpose |
|---|---|---|---|
| **OCI image index** (manifest list) | `sha256:f62d153fd598d68b8651aba5ca62180e6d7e229d39556b0fb2b7ecbda7a68d05` | `application/vnd.oci.image.index.v1+json` | **Pin this in `FLY_DAEMON_IMAGE`** |
| linux/amd64 image manifest | `sha256:b190cccf7dee989a7e37190db9daf44d06e69231538ed5825b386c0d69e06960` | `application/vnd.oci.image.manifest.v1+json` | runtime image (resolved from index) |
| Attestation manifest (SBOM/provenance) | `sha256:388c29ad3a46896264035a6c84911dda9ee9c396b2b91f8b1c7b441bda3862bd` | `application/vnd.oci.image.manifest.v1+json` (attestation) | BuildKit attestation |
| Image config | `sha256:c3cbd8d2a1396c3e054d382a854d00d647de5b81019f3dab28c064d3a471816d` | — | — |

**Build timestamp:** ~2026-05-24T18:20Z (UTC, push completion).

## 4. Gate evidence

All 7 daemon gates run at HEAD `e4d22ad` (the first v0.8.1 commit
before the toolchain follow-on). Re-run post-closure (see §7).

| Gate | Command | Result |
|---|---|---|
| 1. typecheck | `pnpm typecheck` | ✓ |
| 2. lint | `pnpm lint` | ✓ |
| 3. format:check | `pnpm format:check` | ✓ |
| 4. test | `pnpm test` | ✓ **752 passed (752) — 78 files, 11.56s** |
| 5. build | `pnpm build` | ✓ |
| 6. check-llm-types-sync | `node scripts/check-llm-types-sync.mjs` | ✓ (5783 bytes byte-identical) |
| 7. check-chain-hash-sync | `node scripts/check-chain-hash-sync.mjs` | ✓ (6292 bytes byte-identical) |

**Source code unchanged from v0.8.0** — only Dockerfile + package.json
version. So the 752-test baseline is preserved by construction (no
.ts changes possible in this pass per goal scope).

## 5. Smoke evidence (scope-expanded vs v0.8.0)

### Local proxy

```
$ node dist/cli/index.js --version
0.8.1
exit=0
```

### Registry-side .node artifact verification

```
$ docker run --rm registry.fly.io/wotw-daemon:v0.8.1 find /app -path '*better_sqlite3.node*'
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/.deps/Release/obj.target/better_sqlite3.node.d
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/.deps/Release/better_sqlite3.node.d
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/obj.target/better_sqlite3.node
```

The `.node` artifact IS present in the pushed v0.8.1 image (compare to
v0.8.0 where this find command returned empty). The `.deps/` and
`obj.target/` paths are node-gyp build leftovers — harmless intermediate
files that don't affect runtime.

### Container SQL exercise

```
$ docker run --rm registry.fly.io/wotw-daemon:v0.8.1 \
    node -e 'const db = new (require("better-sqlite3"))(":memory:");
              db.exec("CREATE TABLE t(x INTEGER); INSERT INTO t VALUES (1);");
              const row = db.prepare("SELECT x FROM t").get();
              console.log("ok:", JSON.stringify(row));'
ok: {"x":1}
exit=0
```

The native binding loads, opens a database, executes DDL + DML, and
returns the correct row. This is what `FactStore` does at construction.

### Build-time embedded gate

The runtime stage's `RUN node -e '...'` exercises the same chain at
image-build time. Build output confirmed: `better-sqlite3 self-test
passed`. The image build is gated against this regression — any future
push that breaks the binding will fail at this step.

### Out of scope (unchanged from v0.8.0)

The `wotw-entrypoint` per-tenant boot sequence (env-bridge → wotw.yaml
→ `wotw start` with daemon-mode child detach) is still not exercised
in the daemon repo's ship pass. That's the cloud orchestrator's job
at first cloud-side tenant spawn against v0.8.1.

## 6. Handoff to cloud

The cloud-side `/goal` that consumes this ship doc fires:

```
flyctl secrets set FLY_DAEMON_IMAGE=registry.fly.io/wotw-daemon@sha256:f62d153fd598d68b8651aba5ca62180e6d7e229d39556b0fb2b7ecbda7a68d05
```

…replacing the v0.8.0 digest (`sha256:4d13f66f...`). After secret
update, all subsequent `machines/create` calls pin to v0.8.1. Existing
machines on v0.8.0 continue running their broken state until restart
or roll-forward — cloud should drive the rollout deliberately.

**Rollback path:** if v0.8.1 surfaces a regression vs v0.8.0's
non-fact-related paths (extremely unlikely — source unchanged), cloud
pins back to v0.7.0's digest (whichever it was). The v0.8.0 digest is
NOT a safe rollback target since it's the broken one.

## 7. Post-ship gate run

Final 7-gate run scheduled after the closure-doc commit lands. See
the commit `docs(ship-v0.8.1):` for evidence.

## 8. What this pass changed structurally

- **Dockerfile build-stage native-dep handling pattern:** explicit
  rebuild + toolchain + runtime-stage exercise. Standing pattern for
  any future native dep additions.
- **Build-time SQL gate** prevents the missed-bindings class of bug
  from reaching the registry again.
- **Iteration honesty:** preserved two commits (`e4d22ad` + `7c7ca84`)
  rather than amending. Future-self can see prebuild-install's
  fallthrough was the surprise, not the design.

---

**Authority:** Image push verified via `docker buildx imagetools
inspect`. `.node` artifact verified via container `find`. Runtime SQL
exercise verified via container `docker run`. Gate evidence captured
at HEAD `e4d22ad` (toolchain-iteration-included tests pass identically;
re-run post-closure-docs in §7).
