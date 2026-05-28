# watcher-on-the-wall

> A local-first AI knowledge daemon. Drops files in, persistent wiki out.
> Every operation cryptographically signed. Served to any MCP-capable agent.

`wotw` is a small background process. You feed it raw notes, transcripts, and
documents; it writes you an interlinked Obsidian-compatible wiki, refreshes it
as your inputs change, and proves to you (and to auditors) exactly which model
wrote which page from which source at what cost.

It runs entirely on your machine. Your data never leaves unless you wire it
to a hosted LLM yourself (Anthropic, OpenAI, Gemini, or Ollama for fully
offline). Reads happen over MCP, so any agent that speaks Model Context
Protocol — Claude Code, Claude Desktop, Cursor — can query your wiki as a
memory tier.

## Install

```bash
npm install -g @driftvane/wotw
wotw init        # interactive: pick a vault, configure runtime
wotw start       # daemon goes to the background
```

Requires **Node.js ≥ 20**. macOS arm64 / amd64, Linux amd64, Windows amd64.

> **Note (publish-gap window):** `npm install -g @driftvane/wotw` becomes
> available with the v0.8.4 publish. If you see a 404 from the registry,
> the package hasn't shipped yet. To run from source in the meantime:
>
> ```bash
> git clone https://github.com/3030-Labs/watcher-on-the-wall.git
> cd watcher-on-the-wall
> npm install          # use npm, NOT pnpm — see note below
> npm run build
> npm install -g .     # global install from the local checkout
> ```
>
> **Use `npm`, not `pnpm`, for a from-source install.** pnpm 10+ installs
> dependencies through a global content-addressable store and, with
> `pnpm link --global`, splits the dependency tree in a way that leaves
> native addons (`better-sqlite3`, the bundled `claude` binary) unreachable
> at runtime. `npm install -g .` avoids this entirely. (Tracked in
> `PASS-023-DOGFOOD-FINDINGS.md`.)

## 30-second quickstart

```bash
$ wotw init
┌  watcher-on-the-wall — setup wizard
│
◇  Where should your wiki live?
│  ~/Obsidian/research (detected)
│
◇  Which LLM runtime?
│  claude CLI (free with subscription)
│
│  Runtime ─ CLI mode (claude binary found at /usr/local/bin/claude)
│  Next steps ─
│    1. Drop files in ~/Obsidian/research/raw/
│    2. wotw start
│    3. wotw candidates  →  wotw approve  →  pages land in wiki/
│
└  Done! Your wiki is ready.

$ wotw start
daemon running (pid 18412). logs: ~/.wotw/daemon.log

$ cp ~/Downloads/meeting-transcript.md ~/Obsidian/research/raw/
# daemon ingests it + synthesizes related concept pages into candidates/

$ wotw candidates          # list pages awaiting review
$ wotw approve <page>      # promote a candidate into wiki/
# (set ingestion.staging: false in wotw.yaml to auto-approve instead)
```

**Generated pages land in `candidates/` first, not directly in `wiki/`.**
By default `wotw` stages every page for human review — run `wotw candidates`
to list them and `wotw approve <page>` to promote one into `wiki/`. Approval
appends a provenance record attributing the decision to you (`model=user`).
Set `ingestion.staging: false` in `wotw.yaml` to skip review and write
straight to `wiki/`.

Open the vault in Obsidian to see approved pages rendered as linked notes.
The daemon batches subsequent file drops, refreshes stale pages, and signs
every operation into a provenance chain you verify with `wotw audit`.

## What you get

- **Compounding wiki.** Drop a transcript, get categorized markdown with
  YAML frontmatter, internal links, and a generated index. Drop ten more
  on the same topic, get synthesis pages.
- **Provenance you can prove.** Every write — content + model + cost +
  source — appended to a SHA-256 chain. `wotw audit` walks it and reports
  tampering. Cryptographic attestation under tenant-managed keys (G5).
- **MCP-served.** Ten tools over streamable HTTP: search, query, define,
  relate, cite_sources, query_progressive, query_facts, read_page, get_page,
  list_pages. Bearer-token auth, per-IP rate limiting.
- **Local-first, BYOK.** Pick your provider (Anthropic / OpenAI / Gemini /
  Ollama / claude CLI). Your Anthropic key never leaves your machine. The
  wiki and its provenance chain are yours.
- **Token-efficient retrieval.** Context-efficiency Pass A + B ship
  86-99% fewer tokens than naive query retrieval on benchmark fixtures.
  Pure BM25, no embeddings.
- **Audit-ready.** Compliance Pack export (CT4.01) bundles your chain
  with encrypted DEKs for offline verification via the separately
  distributed [wotw-verify](https://github.com/3030-Labs/wotw-verify) Go
  binary. Single statically-linked customer-side verifier, no daemon needed.

## Documentation

| | |
|---|---|
| Up and running | [docs/init-walkthrough.md](docs/init-walkthrough.md) |
| Configuration knobs | [docs/configuration.md](docs/configuration.md) |
| CLI commands | [docs/cli-reference.md](docs/cli-reference.md) |
| MCP tools | [docs/mcp-tools.md](docs/mcp-tools.md) |
| Architecture | [docs/architecture.md](docs/architecture.md) |
| BYOK + LLM providers | [docs/self-hosted-byok.md](docs/self-hosted-byok.md) |
| Fact extraction gating | [docs/llm-provider-auto-resolution.md](docs/llm-provider-auto-resolution.md) |
| Provenance chain format | [docs/provenance.md](docs/provenance.md) |
| Compliance Pack wire format | [docs/pack-format-daemon.md](docs/pack-format-daemon.md) |
| Knowledge health + auto-heal | [docs/knowledge-health.md](docs/knowledge-health.md) |
| Obsidian integration | [docs/obsidian-setup.md](docs/obsidian-setup.md) |
| Multi-user + per-tenant tokens | [docs/multi-user.md](docs/multi-user.md) |
| Retrieval design (BM25 rationale) | [docs/retrieval-hardening.md](docs/retrieval-hardening.md) |
| Opt-in telemetry | [docs/telemetry.md](docs/telemetry.md) |

## Project status

`wotw` is pre-1.0. The substrate (ingestion, provenance, MCP, Compliance
Pack format) is stable and exercised by 900+ tests across 7 build gates;
the npm package is `@driftvane/wotw`. Breaking changes are possible at
minor-version bumps until 1.0; see [CHANGELOG.md](CHANGELOG.md).

## License

[AGPL-3.0-or-later](LICENSE) — see [LICENSE-NOTICES.md](LICENSE-NOTICES.md)
for the plain-English summary (what counts as a derivative work, how a
service offering must comply, what competitors can fork).

## Links

- Reporting a vulnerability: [SECURITY.md](SECURITY.md)
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md)
- Verifier binary: [3030-Labs/wotw-verify](https://github.com/3030-Labs/wotw-verify)
- Marketing + docs site: [wotw.dev](https://wotw.dev)
- Maintainer: [3030 Labs LLC](https://3030labs.io)
