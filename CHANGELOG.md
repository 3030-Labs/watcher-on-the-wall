# Changelog

All notable, user-visible changes to `@driftvane/wotw` are documented in this
file. Internal closure documents (`PASS-*.md`, `SHIP-V*.md`, `REVIEW-*.md`)
are referenced for traceability but not enumerated here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until 1.0, minor-version bumps may carry breaking changes; patch bumps are
always non-breaking.

---

## [0.8.4] — 2026-05-26 — Public-launch readiness (PASS-023)

### Added
- **README rewrite** for first-time visitors: tagline, 5-line install,
  30-second quickstart with concrete output. Deeper feature copy moved
  to [`docs/`](docs/).
- **Install evidence on 4 platforms** committed under
  [`docs/install-evidence/`](docs/install-evidence/): macOS arm64,
  macOS amd64, Linux amd64, Windows amd64. Each carries a passing
  terminal log of `npm install → wotw init → ingest → wiki update`.
- **`docs/self-hosted-byok.md`** — where the Anthropic / OpenAI / Gemini
  key goes, failure modes (missing / invalid / rate-limited), rotation
  procedure for self-hosted users.
- **`docs/llm-provider-auto-resolution.md`** — why Pass B fact extraction
  defaults off under metered API providers (Anthropic / OpenAI / Gemini)
  and on under cost-free runtimes (Claude Code CLI subscription / Ollama),
  with the config override (`fact_extraction.force_enabled`).
- **`docs/pack-format-daemon.md`** — daemon-side wire format for the
  Compliance Pack consumed by the customer-side
  [`wotw-verify`](https://github.com/DriftVane/wotw-verify) binary.
  Marketplace semantics explicitly out of scope.
- **`docs/telemetry.md`** + opt-in BYO-DSN Sentry breadcrumbs on `wotw init`
  failures. **Disabled by default.** No 3030 Labs DSN embedded; users
  provide their own Sentry project via `WOTW_TELEMETRY_DSN`.
- **`LICENSE-NOTICES.md`** — AGPL-3.0 in plain English (derivative work,
  network-use clause, wotw-cloud boundary, fork rules). Attorney-disclaimable.
- **`.github/ISSUE_TEMPLATE/*.yml`** — bug_report, feature_request, question
  as GitHub issue forms. Security disclosures routed to `SECURITY.md`.
- **Error-message audit on 10 unhappy paths** — every one now emits a
  loud, actionable error with the user's next step, not a stack trace.
  Paths: missing `OBSIDIAN_VAULT_PATH`, malformed config, native-binding
  load failure on `better-sqlite3`, invalid Anthropic key (401),
  rate-limited Anthropic (429), missing wiki-dir permissions, locked
  vault file, port conflict, daemon already running, `wotw init` against
  a non-empty vault.

### Changed
- **`CONTRIBUTING.md`** rewritten to centre AGPL implications, the DCO
  sign-off requirement (Developer Certificate of Origin), and the 7-gate
  shipping discipline.
- **`SECURITY.md`** updated SLA (5 business days acknowledgment, 30
  calendar days fix-or-disclosure for high-severity), and adds explicit
  safe-harbor language for good-faith researchers.
- **`package.json`** metadata: homepage points to wotw.dev, keywords
  expanded for npm discovery, `SECURITY.md` + `CHANGELOG.md` +
  `LICENSE-NOTICES.md` now ship in the tarball.

### Verification
- 7 build gates green at HEAD.
- 900+ tests across the unit / integration / e2e tiers.
- Justin dogfood pass: see `PASS-023-DOGFOOD-FINDINGS.md`.
- See `PASS-023-DAEMON-PUBLIC-READINESS.md` for the full closure trail.

---

## [0.8.3] — 2026-05-25 — KEK rotation + DEK auto-archive

### Added
- **KEK rotation** (`wotw keys rotate-kek`): generates a new KEK,
  re-wraps every active and rotating DEK, archives the previous KEK
  metadata. Revoked DEKs are deliberately skipped (compliance: revoked
  material stays revoked).
- **DEK auto-archive cron**: configurable schedule under
  `keys.auto_archive` rolls DEKs from `rotating` → `archived` after a
  retention window expires.
- **`docs/policies/dek-rotation.md`** — operator runbook for both
  manual and scheduled rotation.

### Verification
- See `PASS-019-G5-COMPLETION.md`. CT1.01 (operationally complete) +
  G5 substrate signoff.

---

## [0.8.2] — 2026-05-24 — G5 end-to-end attestation substrate

### Added
- **Workspace-key substrate** (`workspace_keys.db`) under
  `~/.wotw/<tenant>/keys.db`. Active + rotating + archived DEK lifecycle
  states. Hex-encoded encrypted-DEK / nonce / auth-tag columns mirror
  the daemon-cloud wire format.
- **HMAC-SHA256 attestation** field on provenance records: every chain
  entry now carries (optionally) an HMAC under the active DEK,
  enabling offline verification of (record content × key custody)
  without disclosing the DEK itself.
- **`key_id` propagation** in ProvenanceRecord (canonical-payload
  EXCLUDED — see [`docs/provenance.md`](docs/provenance.md)). New
  optional field stored on record for verification routing, not in the
  canonical id hash, preserving backward-compatibility with pre-G5
  daemons.

### Security
- Tenant-managed DEKs never persist as plaintext beyond the
  in-memory KeyStore window.
- KEK plaintext is never logged.

### Verification
- See `PASS-018-G5-CLOSURE.md`. Closes CT1.01 (partial → done) and
  unblocks every downstream CT1.x – CT5.x checklist item.

---

## [0.8.1] — 2026-05-22 — better-sqlite3 native-binding fix

### Fixed
- **Docker image native-binding mismatch**: `better-sqlite3` was being
  copied from a host build into the runtime image, leading to
  `node-gyp` / glibc symbol mismatches at first DB-open. The Dockerfile
  now runs `pnpm rebuild better-sqlite3` against the runtime base image
  and exercises the resulting binding end-to-end as a build-time gate.
  Closes the "first cloud-side spawn" failure pattern.

### Added
- **`scripts/docker-native-rebuild-verify.sh`** — invoked by the
  Dockerfile build stage; refuses to ship if the binding fails to load.

### Verification
- See `SHIP-V0.8.1.md`.

---

## [0.8.0] — 2026-05-19 — Pass B fact-level retrieval + G5 scaffolding

This release bundled two substantive workstreams. Version skipped 0.5 –
0.7 to converge on a single shippable image; commits internally
identified Pass A as v0.7.0 and Pass B as v0.8.0.

### Added — Context-efficiency Pass B (fact-level retrieval)
- **`query_facts`** MCP tool: BM25-fused retrieval over atomic
  `(entity, statement)` pairs + synthetic questions extracted at
  ingestion. **80%+ token reduction** vs page-level retrieval on
  atomic-question benchmark fixtures. See
  [`docs/mcp-tools.md`](docs/mcp-tools.md) and
  [`CONTEXT-EFFICIENCY-PASS-B.md`](CONTEXT-EFFICIENCY-PASS-B.md).
- **`source_layer`** response field on `define` / `relate` /
  `cite_sources` — clients can see whether a hit came from the fact
  layer or the page layer.
- **`fallback: "page-level"`** signal when the fact layer is disabled —
  Pass-A clients route to `query_progressive` automatically without
  manual config.
- **`wotw facts reindex`** — populate the fact layer over an existing
  wiki. Budget-gated, idempotent.
- **`fact_extraction.force_enabled`** config knob — see
  [`docs/llm-provider-auto-resolution.md`](docs/llm-provider-auto-resolution.md)
  for the auto-resolution rationale.

### Added — Context-efficiency Pass A (progressive + structural retrieval)
- **`query_progressive`** MCP tool: smallest-viable-answer-first
  retrieval. Tier-0 (top hit's lede) is ~100-300 tokens with a
  continuation token for expand-on-signal. **86-99% token reduction**
  vs the legacy `query` payload. See
  [`CONTEXT-EFFICIENCY-PASS-A.md`](CONTEXT-EFFICIENCY-PASS-A.md).
- **`estimate_query_cost`** — pre-flight token estimate so clients
  know what a retrieval will cost before committing.
- **`define` / `relate` / `cite_sources`** — narrow structural
  retrieval primitives at 256 / 768 / 512 token caps.

### Added — G5 scaffolding
- Provenance-record HMAC field landed as optional (substrate-only,
  not yet exercised end-to-end — that's v0.8.2). Forward/backward-
  compatible canonical-payload-exclusion: old daemons compute identical
  id+chain_hash with the new field present-but-ignored.

### Verification
- See `SHIP-V0.8.0.md`, `CONTEXT-EFFICIENCY-PASS-A.md`,
  `CONTEXT-EFFICIENCY-PASS-B.md`.

---

## [0.4.0] — 2026-05-15 — Multi-LLM provider closure

### Added
- **Anthropic provider** (the existing built-in, formalized as a
  pluggable provider with config-driven dispatch).
- **OpenAI provider** (Phase 007): GPT-4o + GPT-4o-mini, ingestion
  + query parity.
- **Gemini provider** (Phase 008): gemini-1.5-pro + gemini-1.5-flash,
  ingestion + query parity.
- **Ollama provider** (Phase 009): local-model dispatch over HTTP,
  free runtime tier.
- **Per-tenant provider config** (Phase 010): each tenant selects a
  primary provider + optional fallback chain. `wotw.config.yaml`
  carries `llm.providers[]` with role-typed entries.

### Changed
- **`queue.ts`** main ingestion path refactored to single-pass dispatch
  (Phase 006) — highest-risk regression surface; full Phase A regression
  suite green.
- **`heal-handlers`** likewise refactored to single-pass JSON-edit
  pipeline (Phase 005).

### Verification
- See `MULTI-LLM-PHASE-A.md`, `FEATURE-PASS-005.md` through
  `FEATURE-PASS-010.md`.

---

## [0.2.x] — 2026-04-12 to 2026-05-09 — Patch releases

Hosted-mode fixes, MCP entrypoint correction (`entry.js` vs
`wotw start --foreground`), Fly-registry caching workaround,
`pathToClaudeCodeExecutable` resolution. Tags: `v0.2.3` through
`v0.2.8`.

---

## [0.2.0] — 2026-04-12

### Features
- **Interactive init wizard** (`wotw init`): 7-step @clack/prompts
  wizard with Obsidian vault auto-detection, overlay support, and
  optional vault launch.
- **Knowledge health system**: 5-factor quality scoring (staleness,
  source availability, link health, duplicate risk, contradiction risk)
  with configurable weights and thresholds.
- **Auto-healing** (`wotw lint --fix`): 5 heal handlers (stale pages,
  duplicates, broken links, missing backlinks, contradictions) with
  budget pre-flight, per-run caps, and provenance records.
- **Deletion handling**: archive provenance type for removed source
  files; orphaned wiki pages get `status: orphaned` frontmatter
  instead of deletion.
- **Lint scheduler**: optional background lint runs via
  `lint.schedule_enabled` config with configurable interval.
- **Dead-letter queue**: JSONL ledger for failed batches, surfaced
  in `wotw status` and `get_stats` MCP tool.
- **`wotw logs` command**: tail daemon log with `-f`/`--follow` and
  rotation detection.
- **Retrieval hardening**: LLM-powered query expansion, richer YAML
  metadata extraction, query-performance metrics logging, and
  consolidated search results.
- **Candidates workflow**: human review queue with `wotw approve`,
  `wotw reject`, `wotw candidates`. Superseded-candidate detection
  on re-ingestion.

### Security
- Timing-safe token comparison via `crypto.timingSafeEqual` for
  legacy single-token auth.
- Canonical path validation (`resolveWikiPath`) rejects directory
  traversal.
- No-auth safety rail refuses MCP server start on non-loopback host
  without auth configured.
- Eager provenance hashing eliminates lazy end-of-batch race window.
- Credential redaction (9 patterns) applied to all wiki content
  before storage.

### Quality
- 446 tests across 51 files (up from 192 across 16 in 0.1.0).
- Two independent adversarial audits all resolved.

---

## [0.1.0] — 2026-03-15 — Initial release

### Added
- **Daemon lifecycle:** `wotw init`, `wotw start`, `wotw stop`,
  `wotw status` with detached-child process model, PID/lock file
  management, graceful shutdown.
- **Watcher:** chokidar-backed file watcher with exponential backoff
  debouncing.
- **Ingestion pipeline:** Claude agent runner, wiki-writer
  reconciliation, bidirectional link repair, index rebuild, search
  re-index, git commit per batch.
- **Wiki store:** categorized markdown pages with YAML frontmatter,
  atomic writes, slug sanitization, path-safe IO.
- **Search:** minisearch BM25 with title/tag boost.
- **MCP server:** stateless streamable-HTTP exposing `search`,
  `list_pages`, `read_page`, `query`, `get_index`, `get_stats`,
  `related_pages`, `get_provenance_log`, `verify_provenance`,
  `synthesize`. Rate limiting + bearer-token auth.
- **Cost tracking:** per-operation and daily dollar budgets, hard
  caps enforced before every LLM call.
- **Provenance chain:** append-only SHA-256 chain of every
  state-mutating operation. `wotw audit` walks the chain and reports
  tampering.
- **Multi-user authentication:** optional per-user bearer tokens
  managed by `wotw user add | list | revoke`.
- **Tests:** 192 across 16 files. **Docs:** README, architecture,
  configuration, CLI, MCP, provenance, multi-user.
