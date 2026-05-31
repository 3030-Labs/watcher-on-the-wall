# FEATURE-PASS-011 — Daemon → Cloud Redaction-Emit Wire

**Date:** 2026-05-30
**Branch:** main (no separate branch)
**Closes:** PASS-024 / CT3 daemon-side wire-up (cloud endpoint was shipped
in `wotw-cloud` PASS-024 — `web/app/api/internal/redaction-log/route.ts`).
**Goal:** Wire daemon redaction events to the live cloud endpoint
`/api/internal/redaction-log` with durable, retry-backed emission. A
redaction event is a compliance artifact: it must reach the cloud sink
or be retried until it does — never silently dropped.
**Predecessor:** PASS-024 (cloud-side endpoint, table, audit-log mirror,
`x-sink-key` split-secret auth) → PASS-026 (org migration) → PASS-027
(npm publish + canonical-path validation) → **this pass** (daemon-side
emission).

---

## Emission contract

**Endpoint:** `POST {WOTW_API_BASE_URL}/api/internal/redaction-log`
(defaults to `https://wotw.dev`; HTTPS-only — sink refuses non-`https://`
at construction).

**Auth:** `x-sink-key` header = `WOTW_CLOUD_SINK_SECRET`. Split-secret
posture per `wotw-cloud/web/lib/admin-auth.ts:40-51` — a leaked sink key
must NOT grant access to the broader `/api/cron/*` or `/api/admin/*`
surface, so this is distinct from the `x-admin-key` /
`WOTW_INTERNAL_ADMIN_KEY` used by `cloud-sink.ts` (provenance replica).

**Body:**
```json
{
  "workspace_id": "<uuid — daemon's WOTW_WIKI_ID>",
  "events": [
    {
      "redacted_at": "<ISO-8601 UTC>",
      "rule_id": "<credential_pattern_01..10 | truncation_32kb>",
      "source_file_path": "<absolute or vault-relative path>",
      "redaction_byte_count": <int — UTF-8 bytes of removed material>
    }
  ]
}
```

**Cloud batch cap:** 1000 events per call (PASS-024 route hard limit).
Daemon-side `RedactionSink.post()` enforces the same cap defensively
before calling `fetch`.

**Daemon-side `event_id`:** SENT in the payload. cloud-PASS-028
shipped the daemon-side idempotency half in parallel — added
`daemon_event_id uuid` with a partial unique index on `redaction_log`
and `ON CONFLICT (daemon_event_id) DO NOTHING` in the route. End-to-
end at-most-once across daemon restarts: a re-POSTed batch returns 200
with the conflicting rows skipped server-side. See F1 below — the
cross-repo handshake is closed, not deferred.

## Durability guarantee

1. **Write-before-emit.** Every redaction occurrence inside the daemon
   ingestion pipeline writes a SQLite row to `pending_redaction_emits`
   FIRST (in `src/ingestion/prompt-builder.ts:84+`), THEN the
   `RedactionEmitWorker` ticks the queue and POSTs. The synchronous
   `enqueue()` call inside the prompt-builder loop is the durability
   anchor — even if the daemon dies before any POST attempt, the row
   survives.

2. **Restart re-drain.** On daemon boot, `RedactionEmitStore` re-opens
   the SQLite DB; any rows still in `status='pending'` are picked up
   by the worker's first tick. Verified by
   `test/unit/provenance/redaction-emit-store.test.ts` (close-then-
   reopen file-backed scenario) and
   `test/unit/provenance/redaction-emit-worker.test.ts` (start-after-
   enqueue scenario).

3. **Never-delete discipline.** Rows transition `pending → sent` (on
   200) or `pending → archived` (on attempt-exhaustion). The table
   never sees a `DELETE` from the worker — archived rows stay for
   forensic inspection. Same shape as `workspace_keys` in
   `src/keys/store.ts`.

4. **Exponential backoff on the worker poll interval.** Per the goal's
   "never infinite-tight-loop" requirement. Base 30s, cap 5min, doubles
   on each consecutive failed tick, resets to base on first success.
   Verified by the worker tests' "doubles ... caps ... resets" trio.

5. **Per-row attempt cap.** Default 100 attempts before a row is moved
   to `archived` and surfaced in error logs. At base interval × 100 this
   is hours of retry headroom; past that the cloud is genuinely
   unreachable and operator attention is required.

## Rule mapping (daemon → cloud whitelist)

PASS-024 cloud whitelist accepts 11 rule_ids: `credential_pattern_01..10`
+ `truncation_32kb`. The daemon's `src/utils/sanitize.ts:DEFAULT_REDACTIONS`
has 12 rules. Mapping (locked in `sanitize.ts` definition order so the
table stays self-documenting):

| daemon rule_name      | cloud rule_id          | source                            |
| --------------------- | ---------------------- | --------------------------------- |
| `aws-access-key`      | `credential_pattern_01` | AKIA-prefix detector              |
| `aws-secret-key`      | `credential_pattern_02` | 40-char base64 + secret-context   |
| `github-token`        | `credential_pattern_03` | `gh[pousr]_*` + `github_pat_*`    |
| `anthropic-api-key`   | `credential_pattern_04` | `sk-ant-*`                        |
| `openai-api-key`      | `credential_pattern_05` | `sk-*` (incl. proj/svcacct/admin) |
| `gemini-api-key`      | `credential_pattern_06` | `AIza*`                           |
| `wotw-daemon-token`   | `credential_pattern_07` | `wotw_*` daemon tokens            |
| `private-key-block`   | `credential_pattern_08` | PEM `BEGIN ... PRIVATE KEY` block |
| `jwt`                 | `credential_pattern_09` | `eyJ*.*.*` triple-segment         |
| `password-in-url`     | `credential_pattern_10` | `scheme://u:p@host` userinfo      |
| `credit-card`         | *(unmapped — PII, daemon-local)* | 13-16 digit clusters     |
| `us-ssn`              | *(unmapped — PII, daemon-local)* | `\d{3}-\d{2}-\d{4}`       |
| `truncation_32kb`     | `truncation_32kb`       | MAX_EXCERPT_BYTES cut in prompt-builder |

**PII stays daemon-local.** `credit-card` and `us-ssn` still redact
on-disk (the sanitize output strips them as before), but their
occurrences are NOT emitted to the cloud — the cloud's explicit
whitelist treats PII metadata as data-that-shouldn't-leave-the-daemon.
This matches the privacy posture: the cloud's compliance ledger records
which *credential* patterns fired (operator hygiene signal), not
*which kind of PII* the operator processed (which would be PII metadata
in its own right).

## Files

**New:**
- `src/provenance/redaction-emit-store.ts` — SQLite store, single table
  `pending_redaction_emits`. Mirrors the `src/keys/store.ts` mutation
  + migration pattern.
- `src/provenance/redaction-sink.ts` — HTTPS-only POST client with
  `x-sink-key` auth + `redactionSinkFromEnv` factory.
- `src/provenance/redaction-emit-worker.ts` — `DaemonSubsystem`
  implementing the drain loop with exp-backoff.

**Modified:**
- `src/utils/sanitize.ts` — added `cloud_rule_id?: string` on
  `RedactionRule`, added `sanitizeWithEvents()` (back-compat-preserving
  — `sanitize` + `sanitizeWithReport` unchanged).
- `src/ingestion/prompt-builder.ts` — replaced `sanitize(body)` with
  `sanitizeWithEvents(body)`; added `redactionEmitStore?` +
  `workspaceId?` options for the SQLite hook. Truncation site also
  enqueues a `truncation_32kb` row.
- `src/ingestion/queue.ts` — added `redactionEmitStore?` +
  `redactionWorkspaceId?` to `IngestionQueueOptions`; forwarded to
  `buildIngestionPrompt`.
- `src/daemon/config.ts` — added `validateHostedRedactionSink(config,
  env)` invariant + called from `loadConfig`.
- `src/daemon/entry.ts` — constructs `RedactionEmitStore` + sink +
  worker; passes store + workspace_id into `IngestionQueue`; attaches
  worker as a subsystem.

**Tests (new — 5 files):**
- `test/unit/provenance/redaction-emit-store.test.ts`
- `test/unit/provenance/redaction-sink.test.ts`
- `test/unit/provenance/redaction-emit-worker.test.ts`
- `test/unit/ingestion/prompt-builder-redaction.test.ts`
- `test/unit/config-redaction-sink.test.ts`

**Tests (extended):**
- `test/unit/sanitize.test.ts` — added `sanitizeWithEvents` describe
  blocks for byte-count, multi-rule, PII-no-emit, mapping-shape.

## Test matrix (goal's 7 required scenarios)

| Scenario                                | File                                                 | it() locator                                                                 |
| --------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| **1. queue write-before-emit ordering** | `prompt-builder-redaction.test.ts`                   | "enqueues a credential_pattern row when AWS access key is in input"          |
| **2. backoff on transient failure**     | `redaction-emit-worker.test.ts`                      | "exponential backoff doubles the next-tick interval on consecutive failures" |
| **3. restart re-drain**                 | `redaction-emit-store.test.ts`                       | "survives close + reopen with pending rows intact" + worker "restart re-drain" |
| **4. idempotent replay no-op**          | `redaction-emit-store.test.ts`                       | "markSent on already-sent rows is a no-op (idempotent replay)" + PK uniqueness |
| **5. offline-mode graceful disable**    | `redaction-emit-worker.test.ts`                      | "offline mode (sink=null) is a no-op — no fetch, no crash, queue accumulates" |
| **6. auth header present**              | `redaction-sink.test.ts`                             | "POSTs to /api/internal/redaction-log with x-sink-key header"                |
| **7. chain-write unaffected**           | `prompt-builder-redaction.test.ts`                   | "with-store and without-store produce byte-identical prompt.text"            |

## Findings

### F1 — Cross-repo idempotency handshake — RESOLVED

**Status (updated 2026-05-30 after cloud-PASS-028):** RESOLVED, not
deferred. The cloud half shipped in parallel; the daemon half landed
in this commit. End-to-end at-most-once across daemon restarts.

**Original concern (now closed):** the PASS-024 cloud `redaction_log`
table had no unique key + the route did plain `INSERT` with no
`ON CONFLICT`. A daemon crash between cloud-200 and SQLite-fsync would
cause restart re-drain to re-POST the same batch, creating duplicate
cloud rows.

**Resolution shape:**
1. `wotw-cloud/supabase/migrations/013_redaction_idempotency.sql`
   (cloud-PASS-028) — added `daemon_event_id uuid` column (nullable
   for back-compat) + `CREATE UNIQUE INDEX ... WHERE daemon_event_id
   IS NOT NULL` partial unique index.
2. `wotw-cloud/web/app/api/internal/redaction-log/route.ts`
   (cloud-PASS-028) — extracts `event_id` from each payload event,
   writes as `daemon_event_id`, `ON CONFLICT (daemon_event_id) DO
   NOTHING` — returns 200 with the duplicate rows skipped server-side
   so the daemon's `markSent` flows as if the original POST landed.
3. Daemon-side `RedactionSink.post()` (this commit) — `event_id` is
   now included in each cloud payload event via a new
   `RedactionSinkEvent` type. Worker builds it from store row PK at
   tick time.
4. `RedactionSink.post` test (this commit) — assertion flipped from
   "event_id MUST NOT be in payload" to "event_id IS in payload and
   matches the source row's PK."

**Cross-repo contract handshake verified by Justin 2026-05-30:**
daemon_event_id field matches, 200-on-replay handshake matches,
forward-ready timing has no merge-order trap. Confirmed closed.

**Forward-compat note:** an old daemon (pre-this-commit) talking to
the new cloud (post-PASS-028) would simply omit `event_id` from the
payload, the cloud would write NULL into `daemon_event_id`, and the
partial unique index (`WHERE daemon_event_id IS NOT NULL`) lets these
rows accumulate without conflict. No deployment-order trap.

### F2 — `event_id` is UUIDv4, not ULID, despite goal wording

The goal text said "ULID idempotency pattern already used for emit_event
scaffolding if present." `grep emit_event` in the daemon returned empty:
no scaffolding exists to mirror. Using `crypto.randomUUID()` instead of
adding a `ulid` npm dep — consistent with the existing
`src/keys/store.ts:147` precedent (`randomUUID` for `key_id`). Sortability
isn't needed: the queue is drained oldest-first by `created_at` ISO
timestamp; uniqueness is what's actually load-bearing.

Substantive intent (stable per-event id) is met; literal-text ULID is
substituted for UUIDv4 to stay consistent with the codebase. Same shape
of substitution as PASS-027 F2 (`@3030labs` → `@3030-labs`).

### F3 — "Zod config schema" requirement satisfied by a sibling validator

The goal asked for `WOTW_CLOUD_SINK_SECRET` to be "in the Zod config
schema with a clear error if missing in hosted mode." Env vars aren't
fields in `WotwConfig` (Zod validates the *config-file* shape), so a new
sibling function `validateHostedRedactionSink(config, env)` is wired
alongside `validateHostedConfig` in `src/daemon/config.ts:loadConfig`.
Same fail-loud effect; same call site. Documented as a substantive
substitution rather than a wedge to push env vars into the
config-file-shape Zod schema.

### F4 — PII rules (credit-card, us-ssn) intentionally do NOT emit

The cloud whitelist has exactly 10 credential slots + truncation. Daemon
has 12 redaction rules. Per user authorization 2026-05-30, the two PII
rules redact daemon-locally (the sanitize output still strips them as
before) but do NOT emit. This honors the cloud's whitelist as the policy
boundary: the cloud knowingly tracks credential-pattern occurrences for
operator hygiene; PII *metadata* (volume per PII class) would itself be
sensitive data — keeping it daemon-local is the privacy-positive choice.

If the operator later wants PII occurrence emission, the path is to
extend the cloud whitelist (migration + route + tests) — same shape as
F1's follow-up. NOT a hidden default.

## How to operate

**Hosted-mode boot:** `WOTW_HOSTED=true`, `WOTW_WIKI_ID=<uuid>`,
`WOTW_CLOUD_SINK_SECRET=<live-secret>` (Fly env). Daemon refuses to
start without `WOTW_CLOUD_SINK_SECRET` per
`validateHostedRedactionSink`.

**Local/offline boot:** No env vars required. `RedactionEmitStore` is
constructed at `<wiki_root>/.wotw/redaction-emit.db` regardless. Without
`WOTW_WIKI_ID` the prompt-builder skips `enqueue` (no rows accumulate);
with `WOTW_WIKI_ID` but no `WOTW_CLOUD_SINK_SECRET`, the store accumulates
rows but the worker is a no-op (per goal's "queue rows accumulate" in
offline mode).

**Inspecting the queue:** SQLite at `<wiki_root>/.wotw/redaction-emit.db`,
table `pending_redaction_emits`. Operator-readable; never UPDATEd or
DELETEd outside the daemon. `status = 'pending'` rows are awaiting drain;
`'sent'` is the success-terminal state; `'archived'` indicates exhausted
retries needing investigation.

**Diagnostics:** `RedactionEmitStore.countByStatus()` returns
`{ pending, sent, archived }`. Logged once at daemon startup
(`entry.ts:redaction-emit store ready`).

## Hard gates

| Gate                       | Status | Evidence                                                              |
| -------------------------- | ------ | --------------------------------------------------------------------- |
| Cloud contract confirmed   | ✅     | `wotw-cloud/web/app/api/internal/redaction-log/route.ts`              |
| 935 baseline tests green   | ✅     | Pre-change `pnpm test` run                                            |
| typecheck                  | ✅     | `pnpm typecheck` — clean exit, no errors                              |
| lint                       | ✅     | `pnpm lint` — 0 errors, 0 warnings                                    |
| format:check               | ✅     | `pnpm format:check` — "All matched files use Prettier code style!"    |
| test                       | ✅     | `pnpm test` — **985 passed (95 files)** = 935 baseline + 50 new       |
| build                      | ✅     | `pnpm build` — tsup ESM + DTS for `cli/index`, `daemon/entry`, `index` |

All 7 hard gates closed 2026-05-30. Daemon-side wire-up is operationally
ready; cross-repo cloud-side idempotency follow-up (F1) is the only
deferred item.
