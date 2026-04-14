# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-04-12

### Features

- **Interactive init wizard** (`wotw init`): 7-step @clack/prompts wizard with
  Obsidian vault auto-detection, overlay support, and optional vault launch.
- **Knowledge health system**: 5-factor quality scoring (staleness, source
  availability, link health, duplicate risk, contradiction risk) with
  configurable weights and thresholds.
- **Auto-healing** (`wotw lint --fix`): 5 heal handlers (stale pages, duplicates,
  broken links, missing backlinks, contradictions) with budget pre-flight,
  per-run caps, and provenance records.
- **Deletion handling**: archive provenance type for removed source files;
  orphaned wiki pages get `status: orphaned` frontmatter instead of deletion.
- **Lint scheduler**: optional background lint runs via `lint.schedule_enabled`
  config with configurable interval.
- **Dead-letter queue**: JSONL ledger for failed batches, surfaced in
  `wotw status` and `get_stats` MCP tool.
- **`wotw logs` command**: tail daemon log with `-f`/`--follow` and rotation
  detection.
- **Retrieval hardening**: LLM-powered query expansion, richer YAML metadata
  extraction, query-performance metrics logging, and consolidated search
  results.
- **Candidates workflow**: human review queue with `wotw approve`, `wotw reject`,
  `wotw candidates`. Superseded-candidate detection on re-ingestion.

### Security

- Timing-safe token comparison via `crypto.timingSafeEqual` for legacy
  single-token auth.
- Canonical path validation (`resolveWikiPath`) rejects directory traversal.
- No-auth safety rail refuses MCP server start on non-loopback host without
  auth configured.
- Eager provenance hashing eliminates lazy end-of-batch race window.
- Credential redaction (9 patterns) applied to all wiki content before storage.
- `errMsg()` utility replaced all 18 unsafe `(err as Error).message` casts.
- Zero bare `catch {}` blocks.

### Quality

- 446 tests across 51 files (up from 192 across 16 in 0.1.0).
- Deep verification audit: 36 findings (10 CRITICAL, 8 HIGH) all resolved with
  regression tests that fail on revert.
- Two independent adversarial audits (V1: 16 findings, V2: 13 findings) all
  resolved.

## [0.1.0] — initial release

### Added

- **Daemon lifecycle:** `wotw init`, `wotw start`, `wotw stop`, `wotw status`
  commands with detached-child process model, PID/lock file management, and
  graceful shutdown on `SIGTERM`.
- **Watcher:** chokidar-backed file watcher with exponential backoff
  debouncing and configurable burst threshold.
- **Ingestion pipeline:** Claude agent runner over raw batches, wiki-writer
  reconciliation, bidirectional link repair, index rebuild, search
  re-index, git commit per batch.
- **Wiki store:** categorized markdown pages with YAML frontmatter,
  atomic writes, slug sanitization, path-safe IO.
- **Search:** minisearch-based full-text search with title/tag boost
  and OR-combined natural-language queries.
- **MCP server:** stateless streamable-HTTP transport exposing
  `search`, `list_pages`, `read_page`, `query`, `get_index`,
  `get_stats`, `related_pages`, `get_provenance_log`,
  `verify_provenance`, `synthesize` tools. Rate limiting per IP and
  bearer-token authentication.
- **Query engine:** natural-language query answering grounded in
  retrieved wiki pages with inline citations.
- **Cost tracking:** per-operation and daily dollar budgets, JSONL
  cost log, hard caps enforced before every LLM call.
- **Provenance chain:** append-only SHA-256 hash chain of every
  state-mutating operation. Canonical-JSON content-addressable record
  ids and tamper-evident chain hashes. `wotw audit` walks the chain
  and reports tampering.
- **Compounding synthesis:** tag-cluster detection and background
  synthesis of higher-level wiki pages. Budget-gated and idempotent.
- **Multi-user authentication:** optional per-user bearer tokens
  managed by `wotw user add|list|revoke`. One active token per user,
  stored atomically with `0600` permissions.
- **Tests:** 192 tests across 16 files — unit tests for every
  subsystem, integration tests for the full wiki pipeline (no LLM),
  compounding skip paths, MCP server end-to-end (single-token and
  multi-user), and git committer with real temp repos.
- **Docs:** README, architecture, configuration, CLI reference, MCP
  tools, provenance format, and multi-user guide.
- **CI:** GitHub Actions workflow for lint, typecheck, build, and
  test on Node 20 and 22.
