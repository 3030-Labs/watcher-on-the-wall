# watcher-on-the-wall

> Self-bootstrapping AI knowledge daemon that turns a folder of raw files into a persistent, compounding LLM wiki with provenance signing, MCP serving, and zero manual maintenance.

## What it does

Drop files into a `raw/` directory and `wotw` watches for changes, batches them through a Claude agent, and writes interlinked markdown wiki pages with YAML frontmatter. Every operation is signed into an append-only SHA-256 provenance chain so you can prove which model wrote what, from which inputs, at what cost. The wiki is served to any MCP-capable client (Claude Code, Claude Desktop, IDEs) and designed to use Obsidian as the visual frontend.

## Install

```bash
npm i -g @driftvane/wotw
wotw init
wotw start
```

Drop files into `raw/`. The daemon ingests them, writes wiki pages, and serves them to Claude Code via MCP.

## Key features

The daemon runs as a detached background process with PID/lock management and graceful shutdown. `wotw init` is an interactive wizard that auto-detects Obsidian vaults from the system registry, overlays into existing vaults or scaffolds new ones, and offers to launch the result in Obsidian. Generated pages land in a candidates queue for human review before entering the wiki — approve, reject with feedback, or configure auto-approve. The wiki is full-text searchable via BM25 with title and tag boosting, and supports natural-language queries grounded in retrieved pages with inline citations.

A knowledge health system scores every page on staleness, source availability, link integrity, duplicate risk, and contradiction risk. `wotw lint --fix` auto-heals stale pages, broken links, missing backlinks, duplicates, and contradictions — all budget-gated and capped per run. Every state-mutating operation appends a SHA-256-chained JSONL record; `wotw audit` walks the chain and reports tampering. The MCP server exposes 10 tools over streamable HTTP with bearer-token auth and per-IP rate limiting.

The runtime is dual-mode: use the local `claude` CLI binary (free with a subscription) or the Claude Agent SDK (pay-per-token) — auto-detected at startup. Multi-user authentication supports per-user bearer tokens with atomic token storage. Failed batches are tracked in a dead-letter queue. All credentials and secrets in wiki content are automatically redacted before storage.

## How it works

The file watcher detects changes in `raw/`, debounces them with exponential backoff, and hands batches to the ingestion queue. The queue builds a prompt, runs it through a Claude agent, reconciles the output into categorized wiki pages, rebuilds the search index, signs a provenance record, and commits to git. A compounding engine periodically synthesizes higher-level pages across tag clusters. The MCP server makes the entire wiki queryable by external AI agents.

## CLI

```
wotw init          Scaffold wiki inside an Obsidian vault
wotw start         Start the daemon
wotw stop          Stop the daemon
wotw status        Show daemon health and wiki stats
wotw search        Full-text search across wiki
wotw query         Ask the wiki a natural-language question
wotw lint          Run health checks (--fix to auto-heal)
wotw approve       Approve a candidate wiki page
wotw reject        Reject a candidate with feedback
wotw candidates    List pages awaiting review
wotw audit         Verify the provenance chain
wotw logs          Tail the daemon log
```

## Documentation

- [Architecture](docs/architecture.md) — system design and subsystem interactions
- [Configuration](docs/configuration.md) — every knob in `wotw.yaml`
- [CLI Reference](docs/cli-reference.md) — every command and flag
- [MCP Tools](docs/mcp-tools.md) — the 10 MCP tools and their schemas
- [Provenance](docs/provenance.md) — the cryptographic chain format
- [Execution Modes](docs/execution-modes.md) — CLI vs API runtime
- [Knowledge Health](docs/knowledge-health.md) — scoring, deduplication, and auto-healing
- [Obsidian Setup](docs/obsidian-setup.md) — vault integration guide
- [Multi-User](docs/multi-user.md) — per-user tokens and workspace isolation
- [Retrieval Hardening](docs/retrieval-hardening.md) — query expansion and metadata enrichment

## Requirements

Node.js >= 20. Claude Code or an Anthropic API key.

## License

AGPL-3.0-or-later — [3030 Labs LLC](https://3030labs.io)

## Links

- [GitHub](https://github.com/DriftVane/watcher-on-the-wall)
- [Documentation](https://github.com/DriftVane/watcher-on-the-wall/tree/main/docs)
- [Contributing](./CONTRIBUTING.md)
- [Security](./SECURITY.md)
