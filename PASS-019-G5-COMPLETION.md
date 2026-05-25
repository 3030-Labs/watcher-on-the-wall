# PASS-019 — G5 Completion + v0.8.2/v0.8.3 Ship

**Status:** ✅ Closed (all three parts)
**Date:** 2026-05-25
**Image tags:**
- `registry.fly.io/wotw-daemon:v0.8.2` — Pass 018 G5 substrate, OCI digest `sha256:a40b1619...`
- `registry.fly.io/wotw-daemon:v0.8.3` — KEK rotation + auto-archive cron, OCI digest `sha256:4d26edff...`

**Implementation HEAD:** `9b86597` (`feat(g5): KEK rotation + DEK auto-archive cron`)
**Tag:** `v0.8.3` (annotated, see `git tag -v v0.8.3`)

This pass closes the two G5 items Pass 018 explicitly deferred, and
ships both follow-on images. CT1.01 was already 🟡 → ✅ at Pass 018;
this pass moves the **operational completeness** of CT1.x — KEK
rotation is no longer a runbook stub, and rotating DEKs no longer
accumulate indefinitely.

---

## 1. Three parts, two images, one /goal

| Part | Scope | Image tag | Closure section |
|---|---|---|---|
| A | Ship v0.8.2 image (Pass 018 substrate to registry) | v0.8.2 | `SHIP-V0.8.2.md` |
| B | KEK rotation operation + CLI + tests + runbook | v0.8.3 | §3 of this doc |
| C | DEK auto-archive cron + tests | v0.8.3 | §4 of this doc |

Parts B + C were locked atomic in the /goal directive ("B+C atomic
with each other"). They land in a single commit (`9b86597`) and a
single image (v0.8.3). Part A landed earlier in this pass with its
own commit chain (`7a87c44` + image push) and ships as v0.8.2 with
its own SHIP doc.

## 2. Part A — v0.8.2 image ship

Already closed in `SHIP-V0.8.2.md`. Summary:

- Source HEAD `fb19cdb` (Pass 018 G5 closure) built from this repo's
  unmodified Dockerfile (v0.8.1 native-dep canon preserved).
- OCI index digest: `sha256:a40b1619f5cd8978169b2c738f305b8e31f09c0aa944b30d2c7be4a6ac4a6012`
- Build-time SQL self-test gate fired (`better-sqlite3 self-test passed`).
- Boot smoke: 4s to `/healthz=200`, body confirmed `version: 0.8.2`.
- Push hit the same WSL vsock credential-helper blip as v0.8.1; one
  retry resolved.

Cloud `/goal` handoff details in `SHIP-V0.8.2.md` §6.

## 3. Part B — KEK rotation

### Operation (`src/keys/store.ts:rotateKek`)

Single SQLite transaction that re-encrypts every non-revoked DEK
under a new KEK:

```typescript
rotateKek(newKek: Buffer): { rotated: number } {
  return this.db.transaction(() => {
    const rows = /* SELECT every key_state != 'revoked' */;
    for (const r of rows) {
      const dek = unwrapDek({…}, this.kek);       // decrypt under OLD KEK
      const wrapped = wrapDek(dek, newKek);        // re-encrypt under NEW KEK
      /* UPDATE encrypted_dek + nonce + auth_tag */
    }
    return { rotated: rows.length };
  })();
  // Cache clear + this.kek = newKek happen post-commit.
}
```

### Invariants verified by tests

| Invariant | Test |
|---|---|
| DEK plaintext preserved across KEK rotation | `kek-rotation.test.ts` "re-encrypts every non-revoked DEK ... plaintext preserved" |
| Raw row unwrappable only under new KEK after rotation | "after rotation, raw ciphertext in DB is unwrappable under new KEK only" |
| Revoked rows NOT re-encrypted | "rotateKek returns count of rotated rows (active + rotating + archived, NOT revoked)" |
| Wrong-length new KEK rejected loud | "rejects a wrong-length new KEK loud" |
| Mid-rotation throw → rollback, this.kek unchanged | "if any row fails to unwrap under the old KEK, rotation rolls back and this.kek is unchanged" |
| Idempotent (rotate to same KEK twice) | "rotating to the same KEK twice succeeds and preserves plaintext" |
| Fresh nonces each rotation | "two rotations to the same target KEK produce different ciphertexts (fresh nonces) but same plaintext" |
| Provenance signing continues uninterrupted | `kek-rotation-load.test.ts` "a 50-record chain (25 pre-rotation, 25 post-rotation) tail-verifies green" |
| Daemon restart under new KEK preserves verify | "a fresh KeyStore opened with the new KEK can verify the chain it didn't sign" |
| Old KEK fails to decrypt after rotation (fail-loud) | "opening a KeyStore with the WRONG (old) KEK after rotation fails decryption attempts" |
| DEK rotate + KEK rotate combined: chain verifies | "DEK rotation followed by KEK rotation: chain still verifies across both" |
| Empty workspace rotation is a no-op | "rotateKek on an empty workspace (no DEKs yet) succeeds with rotated=0" |

### CLI

`wotw workspace rotate-kek --confirm` (src/cli/commands/workspace.ts):

- Reads `WOTW_WORKSPACE_KEK_NEW` from env.
- Refuses without `--confirm`.
- Calls `store.rotateKek(parseKek(env.WOTW_WORKSPACE_KEK_NEW))`.
- Reports count + 3-step operator next-actions.
- `--json` flag for CI.

Companion: `wotw workspace archive-overlapped [--overlap-hours N]` —
manual trigger for the Part C cron (force-archive after a successful
rollout, faster than waiting for the hourly cadence).

### Runbook

`docs/policies/kek-rotation.md` — full operator procedure:

- Dual-secret pattern for zero-downtime rotation (set
  `WOTW_WORKSPACE_KEK_NEW` alongside the existing
  `WOTW_WORKSPACE_KEK`, run rotation, swap secret, unset staging).
- 7-step happy path with `flyctl` commands.
- Rollback scenarios at each step.
- Forbidden operations (don't paste KEK plaintext anywhere logged;
  don't delete `.wotw/keys.db`; don't set both secrets to the same
  value).
- Backward-compat note for v0.8.1 daemons.

### Why this is non-trivial

The KEK is the root of the workspace's confidentiality. Rotating it
naively (decrypt all → re-encrypt all → swap reference) could in
principle:

1. Lose a DEK if the transaction commits but the swap doesn't
   (mitigated: swap happens only after commit; if commit failed,
   no swap).
2. Leave `this.kek` pointing at the OLD value while rows are now
   encrypted under NEW (mitigated: swap is the last act, and the
   only way to reach it is past the successful commit).
3. Race against signing requests in-flight (mitigated:
   `KeyStore.resolveById` looks up by `key_id`, decrypts under
   `this.kek`; if rotation completes between the SELECT and the
   actual decrypt, the new row's ciphertext is consistent with the
   new `this.kek`).

The atomicity test ("if any row fails to unwrap under the old KEK,
rotation rolls back and this.kek is unchanged") simulates a corrupt
row inside the transaction; verifies the rollback both at the SQL
level AND at the `this.kek` level by then provisioning + resolving a
fresh row under the (unchanged) old KEK.

## 4. Part C — DEK auto-archive cron

### Operation (`src/daemon/dek-archive-scheduler.ts`)

A new `DaemonSubsystem` mirroring `LintScheduler`:

- Hourly tick (configurable via `WOTW_DEK_OVERLAP_HOURS` env, default 24h).
- Each tick calls `KeyStore.archiveOverlapped(workspaceId, overlapMs, now)`.
- Logs result; in-flight guard skips overlapping ticks.
- Runs once at startup (catches DEKs left rotating from a previous
  daemon process).
- `unref()`'d timer so it doesn't keep the event loop alive on its own.
- Injectable `now` for tests (clock fast-forward without
  monkey-patching globals).

### Wired in `src/daemon/entry.ts`

```typescript
const dekArchiveScheduler =
  keyStore && workspaceId
    ? new DekArchiveScheduler({ keyStore, workspaceId })
    : null;
…
if (dekArchiveScheduler) daemon.attachSubsystem(dekArchiveScheduler);
```

No-op subsystem when `keyStore` is absent (v0.8.1 fallback path). This
makes Pass 019 forward-compat with old daemons: they don't gain a
useless cron.

### Invariants verified by tests

| Invariant | Test |
|---|---|
| Archives rotating DEKs past the overlap window | `dek-archive-scheduler.test.ts` "archives rotating DEKs past the overlap window" |
| Leaves recently-rotated DEKs alone (inside overlap) | "leaves rotating DEKs inside the overlap window alone" |
| Clock fast-forward via injected `now` | "uses injected `now` for clock fast-forward in tests" |
| Idempotent across re-runs | "idempotent across re-runs — second tick is a no-op" |
| Overlap precedence (opts > env > default) | 3 tests for the resolution chain |
| Malformed env values fall back to default | "rejects malformed env values, falls back to default" |
| Subsystem lifecycle clean | start/stop tests, stop-before-start safe |
| Archived DEK still resolves for verify | `kek-rotation.test.ts` "after rotation the previous DEK is still resolvable for verify" + `dek-archive-scheduler.test.ts` "archived DEK behavior in ProvenanceChain" |

### What auto-archive doesn't do

- Doesn't rotate (that's manual operator action via `wotw keys rotate`).
- Doesn't revoke (terminal-immediate compromise response, also
  manual).
- Doesn't run if there's no KeyStore (v0.8.1 fallback path).
- Doesn't run on revoked rows (only `state='rotating'`).

## 5. v0.8.3 image ship

### Build + push

```
docker buildx build --platform linux/amd64 --push \
  -t registry.fly.io/wotw-daemon:v0.8.3 .
```

Build-time gates fired:
- `pnpm rebuild better-sqlite3` ✓ (node-gyp compiled under python3 + make + g++)
- `RUN /app/node_modules/.bin/claude --version` → `2.1.138 (Claude Code)`
- `RUN node -e '<better-sqlite3 SQL exercise>'` → `better-sqlite3 self-test passed`

### Manifest digests

```
docker buildx imagetools inspect registry.fly.io/wotw-daemon:v0.8.3
```

| What | Digest |
|---|---|
| **OCI image index** (pin in `FLY_DAEMON_IMAGE`) | `sha256:4d26edff70043f565d8b61b5b357577a2e0fcd954620e064df89e23c94b95cd6` |
| linux/amd64 image manifest | `sha256:cd1a3b6a43889555ecd871f92161cd18e2120c6e3011840de93596a0fdf3b9f5` |
| Attestation manifest | `sha256:64d17d78695d6747c49308ba5e734f82c937db0d48b8e1808ec0cf4ecfca8028` |
| Image config | `sha256:10bb90a9397ce01080b77048bb651a545802de93ef075e9a4f551b685e96a493` |

**Build timestamp:** 2026-05-25T03:08Z.

### Artifact + boot verification

```
$ docker run --rm registry.fly.io/wotw-daemon:v0.8.3 find /app -path '*better_sqlite3.node*'
/app/node_modules/.pnpm/better-sqlite3@12.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node
…

$ docker run -d -e TENANT_ID=<UUID> -e ANTHROPIC_API_KEY=sk-fake \
    -e WIKI_ROOT=/data/smoke -e ADMIN_SERVICE_KEY=smoke \
    -p 13031:3000 --name wotw-smoke-083 \
    registry.fly.io/wotw-daemon:v0.8.3
$ curl -sf http://127.0.0.1:13031/healthz
{"ok":true,"name":"watcher-on-the-wall","version":"0.8.3"}
# Boot-to-healthy: 4 seconds.
```

Both Part C subsystems wired in at boot: lint scheduler + DEK
auto-archive scheduler. Auto-archive runs immediately on startup
catching any rotating DEKs left from a previous daemon process; logs
a result line.

## 6. Gate evidence (final)

All 7 daemon gates green at HEAD `9b86597` (post B+C):

| Gate | Command | Result |
|---|---|---|
| 1. typecheck | `pnpm typecheck` | ✓ |
| 2. lint | `pnpm lint` | ✓ (0 errors, 0 warnings) |
| 3. format:check | `pnpm format:check` | ✓ |
| 4. test | `pnpm test` | ✓ **852 passed (852)** across 87 files |
| 5. build | `pnpm build` | ✓ |
| 6. check-llm-types-sync | `node scripts/check-llm-types-sync.mjs` | ✓ 5783 bytes byte-identical |
| 7. check-chain-hash-sync | `node scripts/check-chain-hash-sync.mjs` | ✓ 6292 bytes byte-identical |

**Test count progression:**

| Pass | Pre | New | Post |
|---|---|---|---|
| Pass 017 (v0.8.1 ship) | 752 | — | 752 |
| Pass 018 (G5 substrate) | 752 | +61 | 813 |
| PASS-019 B+C | 813 | +39 | **852** (above the 850 hard gate) |

PASS-019 test additions:
- `test/unit/keys/kek-rotation.test.ts` (14)
- `test/unit/keys/kek-rotation-load.test.ts` (8)
- `test/unit/keys/dek-archive-scheduler.test.ts` (12)
- `test/unit/keys/workspace-cli.test.ts` (5)

**HMAC overhead bench unchanged** — KEK rotation is rare/manual and
auto-archive is a separate cron path; neither touches `append()`.
Bench still at 0.463ms p99 added latency (well under 1ms budget).

## 7. Cloud handoff (two-step)

The cloud-side `/goal` consuming this pass has two stages:

### Stage 1 — Pin v0.8.2 (Pass 018 substrate)

```
flyctl secrets set --app <wotw-cloud-daemon-app> \
  FLY_DAEMON_IMAGE=registry.fly.io/wotw-daemon@sha256:a40b1619f5cd8978169b2c738f305b8e31f09c0aa944b30d2c7be4a6ac4a6012
```

This activates the G5 substrate. After daemon restart with
`WOTW_WORKSPACE_KEK` populated, each tenant gets a provisioned active
DEK and starts stamping `key_id` on chain records.

### Stage 2 — Pin v0.8.3 (KEK rotation + auto-archive)

```
flyctl secrets set --app <wotw-cloud-daemon-app> \
  FLY_DAEMON_IMAGE=registry.fly.io/wotw-daemon@sha256:4d26edff70043f565d8b61b5b357577a2e0fcd954620e064df89e23c94b95cd6
```

This activates the auto-archive cron + makes `wotw workspace rotate-kek`
operationally available. Skip Stage 1 if pinning directly to v0.8.3 —
v0.8.3 strictly supersedes v0.8.2.

**Rollback path**: If v0.8.3 surfaces a regression vs v0.8.2, the
operator can pin back to the v0.8.2 OCI index digest. Chains attested
under v0.8.3 verify identically under v0.8.2 (rotation is a storage-
layer concern; record canonical-payload shape is unchanged).

## 8. Operational reach after this pass

Before PASS-019:
- KEK rotation: theoretical (no code path); compromise response was
  "regenerate everything from scratch."
- DEK rotation: manual via `wotw keys rotate`; rotating DEKs lived
  forever in `state='rotating'` (cosmetic, but operator-confusing).

After PASS-019:
- KEK rotation: single CLI command + runbook; zero-downtime via
  dual-secret pattern; integration-tested against in-flight signing
  load.
- DEK rotation: still operator-driven; auto-archive cron handles
  the cleanup phase so `state='rotating'` doesn't accumulate.
- Full Compliance-tier substrate operational: every CT-x item
  downstream of CT1.01 can now lean on a key-rotation story that's
  ship-quality, not just architecturally sketched.

## 9. What's next (out of scope of this pass)

- **CT1.02** — Compliance tier checkout SKU + Stripe Price ID
- **CT2.x** — Retention policy UI + enforcement cron
- **CT3.x** — Redaction audit + RLS immutability
- **CT4.x** — Compliance Pack export consuming the now-stable KEK
  rotation procedure
- **CT5.01** — `wotw-verify` Go binary consuming the frozen
  `/internal/verify` contract (Pass 018 §4)
- **KEK custody on a managed KMS provider** (vs. Fly secret) — Pack
  marketplace partnership consideration; KMS rotation procedure is
  the dual-secret pattern's siblings
- **Background rotation policy** — automatic monthly DEK rotation
  via a separate scheduler. The infrastructure is there
  (`KeyStore.rotate()` + `archiveOverlapped()`); only the policy
  isn't. Defer to a future pass when product decides cadence.

---

**Authority:** All three parts verified on-disk + on-registry + in
the production-shaped boot smoke. Commit `9b86597` carries Parts B+C
as a single atomic patch; commit `7a87c44` carries Part A's ship doc;
this closure doc + `SHIP-V0.8.2.md` + `docs/policies/kek-rotation.md`
are the operator-facing record.
