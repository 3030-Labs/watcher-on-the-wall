# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
