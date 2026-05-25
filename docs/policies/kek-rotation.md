# KEK Rotation Runbook

Operator-facing procedure for rotating the workspace key-encryption-key
(KEK) without losing access to any historical DEK (data-encryption-key)
or breaking the G5 attestation chain.

**Audience:** operators with Fly secret-set rights for the per-tenant
daemon Fly app.

**When to run:**
- Scheduled rotation per the compliance tier's key-rotation cadence
  (default: annually, per the Compliance tier SOC 2 controls).
- Compromise response: KEK suspected disclosed (Fly secret leaked,
  operator credentials breached, etc.).
- Vendor change: switching KEK custody from a single Fly secret to a
  cloud KMS provider (deferred — separate pass).

**Cost:** ~milliseconds per DEK row. A workspace with 10 historical
DEKs (active + rotating + archived) re-encrypts in well under one
second. No downtime if executed via the dual-secret pattern below.

---

## Architecture recap

The daemon's workspace key substrate (PASS-018, v0.8.2+) stores
per-workspace DEKs encrypted under a single KEK. The KEK lives in the
Fly secret `WOTW_WORKSPACE_KEK` (32 bytes, base64- or hex-encoded). DEK
plaintexts are never persisted; they're held in process memory only.

When the KEK is rotated, every non-revoked DEK row in `.wotw/keys.db`
gets re-encrypted under the new KEK in a single SQLite transaction
(`KeyStore.rotateKek`, src/keys/store.ts). DEK plaintexts are
unchanged, so:

- Records signed by any historical DEK still verify after KEK rotation.
- The `ProvenanceChain.append()` + `verify()` paths don't know the KEK
  changed — they operate on plaintext DEKs.

The Fly secret swap is **out of the daemon's hands** — the daemon
doesn't have flyctl credentials inside the container. The operator
sets the new KEK alongside the old, runs the rotation, then swaps the
old out.

---

## Standard rotation procedure (zero downtime)

### Step 1 — Generate the new KEK out of band

On a trusted workstation (NOT inside the daemon container):

```
openssl rand -base64 32
```

Copy the output (e.g. `n6sP9Kx...lqA=` — exactly 32 bytes when decoded).
Treat this value as a hot secret: don't paste into chat, email, or
logging-enabled shells.

### Step 2 — Stage the new KEK as a Fly secret alongside the old

```
flyctl secrets set --app <wotw-cloud-daemon-app> \
  WOTW_WORKSPACE_KEK_NEW=<base64-from-step-1>
```

This is **additive** — the existing `WOTW_WORKSPACE_KEK` stays in
place. Fly will trigger a deploy of the machines to pick up the new
secret. Wait for the deploy to finish (`flyctl status` shows all
machines back to `running`).

### Step 3 — Verify both secrets are visible to the daemon

```
flyctl ssh console --app <wotw-cloud-daemon-app> --command \
  'sh -c "echo WOTW_WORKSPACE_KEK is set: \${WOTW_WORKSPACE_KEK:+yes}; echo WOTW_WORKSPACE_KEK_NEW is set: \${WOTW_WORKSPACE_KEK_NEW:+yes}"'
```

Both should print `yes`. If `WOTW_WORKSPACE_KEK_NEW` is missing, the
deploy didn't fully propagate; wait or re-issue Step 2.

### Step 4 — Invoke the rotation

```
flyctl ssh console --app <wotw-cloud-daemon-app> --command \
  'sh -c "cd /data/<tenant-id> && wotw workspace rotate-kek --confirm"'
```

Expected output:

```
✔ Rotated KEK for <tenant-id> — N DEK row(s) re-encrypted.
ℹ Next steps (operator):
  1. Verify daemon still serves /healthz and chain verifies (run `wotw status` + the cloud-side verify probe).
  2. Swap the Fly secret: set WOTW_WORKSPACE_KEK to the new KEK, unset WOTW_WORKSPACE_KEK_NEW.
  3. Restart the daemon — it should re-open keys.db cleanly under the new KEK.
```

**If this step fails** (output is `✖ failed to ...` or non-zero exit),
STOP. Do not proceed to Step 5. The daemon is still running under the
old KEK and chains are intact. See the rollback section below.

### Step 5 — Verify the chain still attests

Run a chain verification from the cloud control plane:

```
curl -sf -X POST -H "x-admin-key: $WOTW_INTERNAL_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"tenant_id":"<tenant-id>"}' \
  https://<machine-id>.vm.<app>.internal:3000/internal/verify | jq .
```

Expect `ok: true` and `errors: []`. If anything other than `ok: true`,
STOP — the rotation altered the on-disk state but the chain doesn't
verify. See rollback.

### Step 6 — Swap the Fly secret + clear the staging secret

```
flyctl secrets set --app <wotw-cloud-daemon-app> \
  WOTW_WORKSPACE_KEK=<base64-from-step-1>

flyctl secrets unset --app <wotw-cloud-daemon-app> \
  WOTW_WORKSPACE_KEK_NEW
```

Each `flyctl secrets` call triggers a deploy. Wait for it to finish.

### Step 7 — Final verification post-restart

```
flyctl ssh console --app <wotw-cloud-daemon-app> --command \
  'curl -sf http://127.0.0.1:3000/healthz'

curl -sf -X POST -H "x-admin-key: $WOTW_INTERNAL_ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{"tenant_id":"<tenant-id>"}' \
  https://<machine-id>.vm.<app>.internal:3000/internal/verify | jq .
```

`/healthz` returns 200 + version string. `/internal/verify` returns
`ok: true`. Rotation complete.

---

## Rollback

The window where rollback is needed is between Step 4 (rotation ran)
and Step 6 (Fly secret swapped). After Step 6, the old KEK is no
longer in env and rollback requires re-introducing it.

### If Step 4 succeeded but Step 5 verify fails

The DEK rows are now encrypted under the new KEK. The daemon's
in-memory `KeyStore.kek` is also the new KEK. To revert:

1. Set the NEW KEK as a temporary "rollback original":
   ```
   flyctl secrets set --app <app> \
     WOTW_WORKSPACE_KEK_NEW=<OLD-base64-from-prior-rotation-or-bootstrap>
   ```
2. Run rotation again — this re-encrypts back to the original KEK:
   ```
   wotw workspace rotate-kek --confirm
   ```
3. Verify chain.
4. Restore Fly secret state to pre-Step-2 (only `WOTW_WORKSPACE_KEK` is
   set, no `_NEW`).

This is symmetric — the same rotate-kek mechanism is bidirectional.

### If Step 4 itself failed

The transaction rolled back automatically. `this.kek` is unchanged in
the daemon process. No rollback needed; investigate the cause:

- `WOTW_WORKSPACE_KEK_NEW` not parseable (length, encoding)
- Old KEK was already rotated by a parallel operator — check
  `wotw workspace ... list` for unexpected state
- One of the rows can't decrypt under the current KEK (corruption or
  prior tampering). Run `wotw status` + chain verify to assess
  damage scope.

### If the daemon was restarted between Step 4 and Step 6

The new KEK isn't yet in `WOTW_WORKSPACE_KEK`, only in
`WOTW_WORKSPACE_KEK_NEW`. The daemon will boot under the OLD KEK from
`WOTW_WORKSPACE_KEK`, which can't decrypt the (now-newly-encrypted)
DEK rows. The daemon will log fatal errors on any `resolveById` call.

To recover: set `WOTW_WORKSPACE_KEK` to the new value (the operator
chose this anyway in Step 6) and restart. The daemon picks up the new
KEK and resumes normally.

---

## Forbidden operations

- **Never set `WOTW_WORKSPACE_KEK` and `WOTW_WORKSPACE_KEK_NEW` to the
  same value.** That's a no-op rotation that obscures whether you
  intended to rotate at all. The rotation primitive is idempotent
  (running it twice with the same value is safe), but recording the
  intent matters for audit.
- **Never delete `.wotw/keys.db` to "start fresh".** That orphans every
  chain record signed under those DEKs — verify will fail loud on
  `record key_id=... not found in keyStore`.
- **Never paste the KEK plaintext anywhere logged.** This includes
  ChatOps integrations, CI logs, screenshare commentary. Use the Fly
  secrets CLI directly from a private terminal.

---

## Backward compatibility note

A daemon running under v0.8.1 or earlier has no KeyStore — it uses the
4-tier fallback HMAC resolution (env → derive-from-tenant-id). KEK
rotation is a no-op on those daemons (nothing to rotate). The Fly
secret `WOTW_WORKSPACE_KEK` is unused there; setting it doesn't break
anything.

When you ship a daemon image upgrade from v0.8.1 → v0.8.2+, the FIRST
boot under v0.8.2 with `WOTW_WORKSPACE_KEK` present provisions a fresh
DEK at `.wotw/keys.db`. From that point forward, new records carry
`key_id` and are verified through the KeyStore path. Pre-upgrade
records (no `key_id`) continue to verify via the 4-tier fallback. KEK
rotation only affects DEKs in `keys.db` — pre-G5 records are
untouched.
