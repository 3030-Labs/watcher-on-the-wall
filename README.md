# watcher-on-the-wall

**A self-bootstrapping persistent AI knowledge daemon.**
Your AI agents share a brain. It builds itself.

`wotw` is a background daemon that watches a directory of raw notes (markdown,
text, or anything else you drop in), turns them into a structured wiki of
cross-linked pages using Claude, serves that wiki to any MCP-capable client
(Claude Desktop, Claude Code, IDEs), and cryptographically signs every change
so you can prove exactly which model wrote what, from which inputs, at what
cost. When your wiki gets large enough, it starts compounding — synthesizing
higher-level pages that span multiple source documents.

It is designed to run for months at a time on a personal machine or a small
server, to be cheap to operate (claude-haiku-4-5 by default), and to be
verifiable down to the byte.

---

## Features

- **Dual-mode runtime.** Hosts the Claude agent loop via either the local
  `claude` CLI binary (free, subscription-covered) or the Claude Agent SDK
  (pay-per-token). Auto-detects which one is available at startup. See
  [docs/execution-modes.md](docs/execution-modes.md).
- **File-watch ingestion.** Drop a note into `wiki-store/raw/` and the
  daemon picks it up, batches with its neighbors (exponential backoff), and
  hands the batch to a Claude agent that writes structured wiki pages.
- **Structured wiki store.** Pages are YAML-frontmatter markdown under
  `wiki-store/wiki/{concepts,entities,events,decisions,syntheses,...}/`.
  Every page has a title, category, tags, sources, related links, and a
  confidence score.
- **Full-text search** via minisearch with title/tag boost and OR-combined
  natural-language queries.
- **MCP server** exposing tools: `search`, `list_pages`, `read_page`,
  `query`, `get_index`, `get_stats`, `related_pages`, `get_provenance_log`,
  `verify_provenance`, `synthesize`. Stateless streamable-HTTP transport.
- **Cryptographic provenance chain.** Every ingestion, query, and synthesis
  appends a SHA-256-chained JSONL record committing to its inputs, prompt,
  model, response, and written files. `wotw audit` walks the chain and
  reports tampering.
- **Compounding synthesis.** When multiple pages share a tag, the daemon
  runs a background pass that reads them all and writes a higher-level
  `syntheses/<topic>.md` page. Budget-gated, idempotent.
- **Multi-user auth.** Optional per-user bearer tokens stored in a
  JSON file under `workspaces_dir`, managed by `wotw user add|list|revoke`.
- **Cost tracking.** Every LLM call is logged with dollar cost; a hard
  daily budget prevents runaway spend.
- **Git-backed history.** The wiki root is a git repo. Every batch is a
  commit with the operation id and cost in the message.
- **Single binary.** One `wotw` CLI covers everything: `init`, `start`,
  `stop`, `status`, `query`, `audit`, `lint`, `synthesize`, `user`, `serve`.

---

## Quickstart

```bash
# 1. Install
pnpm add -g watcher-on-the-wall
# or clone & build from source:
git clone https://github.com/your-org/watcher-on-the-wall.git
cd watcher-on-the-wall && pnpm install && pnpm build && pnpm link --global

# 2. Interactive setup wizard — detects Obsidian vaults, scaffolds the
#    layout, writes the config, initializes git, and offers to open the
#    result in Obsidian. For non-interactive use (CI, scripts) pass --yes.
wotw init               # interactive wizard
# or: wotw init ./my-brain --yes   # non-interactive, explicit path
cd my-brain

# 3. Either install the Claude CLI (free, subscription-covered)...
#    https://docs.claude.com/claude-code
#    ...OR set an Anthropic API key (pay-per-token):
export ANTHROPIC_API_KEY=sk-ant-...

# 4. Start the daemon (auto-detects whichever runtime is available)
wotw start

# 5. Drop a note into the raw dir
echo "Hash chains are sequences where each record commits to the previous via SHA-256." \
  > raw/notes.md

# 6. Watch the wiki get built
wotw status --watch

# 7. Ask it something
wotw query "what is a hash chain?"
```

The `wotw init` wizard is Obsidian-aware: it reads your Obsidian
registry, lists existing vaults, overlays `raw/` + `wiki/` into an
existing vault (or creates a fresh one with sensible defaults), and
offers to launch the vault in Obsidian on completion. See
[docs/obsidian-setup.md](docs/obsidian-setup.md) for the full
integration guide.

Once the daemon is running, point any MCP client at
`http://127.0.0.1:8787/mcp` with a bearer token (see
[docs/multi-user.md](docs/multi-user.md)).

---

## Architecture at a glance

```
┌─────────────┐      ┌──────────────┐      ┌──────────────┐
│  raw/*.md   │─────▶│   watcher    │─────▶│  ingestion   │
└─────────────┘      └──────────────┘      └──────┬───────┘
                                                  │ claude-haiku-4-5
                                                  ▼
                                           ┌──────────────┐
                                           │  wiki pages  │
                                           │  (markdown)  │
                                           └──────┬───────┘
                                                  │
                  ┌───────────────────────────────┼─────────────────────────┐
                  ▼                               ▼                         ▼
           ┌─────────────┐                 ┌─────────────┐          ┌──────────────┐
           │   search    │                 │ provenance  │          │ compounding  │
           │ (minisearch)│                 │   chain     │          │  synthesis   │
           └──────┬──────┘                 │ (sha-256)   │          └──────────────┘
                  │                        └─────────────┘
                  ▼
           ┌─────────────┐
           │  mcp server │──▶ Claude Desktop / Claude Code / custom clients
           └─────────────┘
```

See [docs/architecture.md](docs/architecture.md) for the full picture.

---

## Documentation

- [docs/architecture.md](docs/architecture.md) — system design
- [docs/configuration.md](docs/configuration.md) — every knob in `wotw.config.yaml`
- [docs/execution-modes.md](docs/execution-modes.md) — CLI vs API runtime modes
- [docs/cli-reference.md](docs/cli-reference.md) — every CLI command and flag
- [docs/mcp-tools.md](docs/mcp-tools.md) — every MCP tool
- [docs/provenance.md](docs/provenance.md) — the cryptographic chain format
- [docs/multi-user.md](docs/multi-user.md) — per-user tokens and workspace isolation

---

## License

AGPL-3.0-or-later. Copyright © 3030 Labs LLC.

If you need a commercial-friendly license, open an issue.
