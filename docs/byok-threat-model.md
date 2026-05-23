# BYOK Threat Model

**Daemon version target:** v0.5.0 (post-Layer-1 remediation pass)

This document captures the threat model the daemon's BYOK (Bring Your Own
Key) and tenant-isolation defenses target. It also explains the boundary
between what the daemon enforces and what the surrounding deploy stack
(Fly Machines, wotw-cloud orchestrator, Supabase RLS) enforces — and why
some "defense-in-depth" code that prior reviewers flagged as missing was
deliberately removed in this pass.

## Threat boundaries

| Boundary | Owner | Mechanism |
|---|---|---|
| Tenant A's daemon process cannot read Tenant B's files | Fly Machine isolation | Per-tenant Fly app + volume; Tenant A's container has no Tenant B mount |
| Tenant A's daemon cannot reach Tenant B's daemon over 6PN | Daemon `WOTW_HOST` config + Fly 6PN ACL (out of daemon scope) | Daemon binds to `::` for cloud→daemon reachability, but only the wotw-cloud orchestrator knows tenant hostnames |
| BYOK Anthropic/OpenAI/Gemini key never persists in container env | wotw-cloud orchestrator | Fly secret store; daemon reads at provider-construction time only |
| `WOTW_LLM_PROVIDER` + `WOTW_LLM_MODEL` arrive via Fly secrets (not `config.env`) | wotw-cloud orchestrator (Pass 016 / L1-F1) | `tenant-orchestrator.ts` `setSecret` in provisionTenant + rotateTenantKey; daemon's `applyEnvOverrides` reads `process.env.WOTW_LLM_PROVIDER` either way. Provider switches now propagate via the same setSecret + restartMachine cycle as the API key — no `updateMachine` config rewrite required. |
| BYOK key never logged | Daemon Pino redact + sanitize | `redact.paths` allowlist (review item 1) + sanitize regex (item 2) |
| /internal/* admin gate | Daemon `WOTW_INTERNAL_ADMIN_KEY` | `timingSafeEqual` constant-time compare (item 59) |
| /mcp bearer | Daemon `WOTW_MCP_BEARER` | Per-request bearer check |
| Outbound cloud-sink secret | Daemon `WOTW_CLOUD_SINK_SECRET` | `x-admin-key` header on cloud-sink POST |
| SSRF on /internal/ingest | Daemon `safe-fetch.ts` | Layered IP rejection + content-length cap + streaming (item 49) |
| Provenance chain forge/delete detection | DEFERRED (G5) | HMAC signing OR external anchor file — not yet implemented |

## What the daemon explicitly does NOT enforce

Per X3 (cross-reviewer S7), the following were implemented as
defense-in-depth in `src/hosted/` but **never wired into production
code paths** — they tested clean but enforced nothing at runtime:

- `TenantFs` symlink/path-escape rejection — Fly Machine per-tenant
  isolation makes this redundant. Each tenant gets its own Fly app +
  volume; there is no shared filesystem surface across tenants for
  TenantFs to gate.
- `StorageAccountant` storage-quota tracking — superseded by Fly
  volume size limits set at provision time by wotw-cloud.
- `DailyImportCounter` + `IngestBytesCounter` — superseded by the
  daemon's existing `CostTracker` daily/per-ingest USD caps + the
  cloud-side rate-limiting on the `/api/sources/trigger-ingest`
  endpoint.
- `HealCooldown` — superseded by review item 30 (heal idempotency
  markers; deferred to next pass) and the existing `lint.interval_hours`
  schedule.
- `MetricsCollector` — superseded by Pino structured logs + Fly's
  built-in metrics scraping. Counters in-memory provide no value
  when the daemon process is per-tenant and short-lived.

These were deleted from the daemon in this pass per X3 recommendation.
The deletion rationale: **defense coded but not wired in** is worse
than defense not present at all — it gives operators false confidence
that a quota check fires when it doesn't, and adds maintenance
surface that has to keep typechecking + testing without protecting
anything.

## Pass 016 / L1-F1 — Fly secrets shift for provider/model env vars

The wotw-cloud Layer 1 audit surfaced `rotateTenantKey` provider-switch
desync (L1-F1): when a tenant switched provider via `/api/settings`
(e.g. anthropic → openai), the new API key was setSecret correctly,
but the daemon kept routing through the OLD provider because its
`WOTW_LLM_PROVIDER` env var was pinned at provision time via Fly
`config.env` block. `restartMachine` re-reads Fly secrets but not
`config.env` — only `updateMachine` rewrites that, and the orchestrator
didn't call it during rotation.

The closure pass moves both `WOTW_LLM_PROVIDER` and `WOTW_LLM_MODEL`
out of the audit-visible `config.env` block and into the Fly secret
store, alongside the existing `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` /
`GOOGLE_API_KEY` / `ADMIN_SERVICE_KEY` secrets.

**Daemon-side impact:** none on source. `applyEnvOverrides` in
`src/daemon/config.ts` reads `process.env.WOTW_LLM_PROVIDER` and
`process.env.WOTW_LLM_MODEL` — both Fly secrets and `config.env`
values land in `process.env` identically at machine-start time.
The daemon needs no code change to accommodate this shift; verified
at HEAD `b421024`.

**Effect:** provider switches now propagate to the daemon via the same
`setSecret + restartMachine` cycle as API-key rotation. No
`updateMachine` config rewrite. The dance the pre-fix `rotateTenantKey`
would have had to do (to maintain config.env consistency) is gone.

This is a wotw-cloud-side change. The wotw-cloud commit closing L1-F1
modified `web/lib/fly/types.ts` (removing `WOTW_LLM_PROVIDER` and
`WOTW_LLM_MODEL` from the `MachineEnvKey` allowlist), `tenant-orchestrator.ts`
(adding `setSecret` calls in `provisionTenant` step 3 and `rotateTenantKey`
body), and the runtime allowlist test in `lib/fly/__tests__/tenant-orchestrator.test.ts`
(which now asserts WOTW_LLM_PROVIDER and WOTW_LLM_MODEL are NOT in
`createMachine` env). See REMEDIATION-LAYER-1-PHASE-C.md in the
wotw-cloud repo for full closure detail.

## What's outside this document

- Daemon-internal threat model for arbitrary-LLM-output handling
  (prompt injection via source files, vocab-enricher path-traversal,
  heal-handler raw/-block) — those are in their respective code
  comments + tests.
- Cross-tenant data-flow at the wotw-cloud layer — that's the
  wotw-cloud threat model, separate document.
- Cryptographic primitives for the provenance chain (Merkle root,
  HMAC, external anchor) — deferred to G5 phase.
