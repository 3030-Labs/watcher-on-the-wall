---
title: Getting Started
category: concept
created: __WOTW_UPDATED_ISO__
updated: __WOTW_UPDATED_ISO__
sources: []
related: []
tags:
  - onboarding
  - guide
confidence: high
---

# Getting Started with Watcher on the Wall

Welcome! This page will help you start building your knowledge base.

## Quick Start

1. **Drop files into `raw/`** — articles, papers, notes, PDFs, code, anything.
2. **Run `wotw start`** — the Watcher begins watching `raw/` for changes.
3. **Watch your wiki grow** — the Watcher automatically ingests files, extracts concepts, and creates interlinked pages.

## How It Works

The Watcher monitors your `raw/` directory for new and changed files. When it
detects a change, it:

1. Reads the source file(s)
2. Sends them to an LLM for analysis
3. Creates or updates wiki pages in the appropriate category
4. Repairs cross-references between pages
5. Rebuilds the search index
6. Commits changes to git

Every action is recorded in an append-only **provenance chain** so you can
always trace where information came from.

## Wiki Structure

Your wiki is organized into six categories:

| Category | Directory | What goes here |
|----------|-----------|----------------|
| Concepts | `wiki/concepts/` | Ideas, frameworks, theories, patterns |
| Entities | `wiki/entities/` | People, organizations, products, tools |
| Sources | `wiki/sources/` | Summaries of ingested raw files |
| Comparisons | `wiki/comparisons/` | Side-by-side analyses of related topics |
| Syntheses | `wiki/syntheses/` | Cross-cutting themes and insights |
| Queries | `wiki/queries/` | Answers to questions you've asked |

## Useful Commands

| Command | Description |
|---------|-------------|
| `wotw start` | Start the daemon (watches `raw/` for changes) |
| `wotw stop` | Stop the daemon |
| `wotw status` | Check daemon status, page counts, health |
| `wotw query "question"` | Ask a question (uses the running daemon) |
| `wotw search <terms>` | Offline full-text search (no daemon needed) |
| `wotw lint` | Check wiki health and find issues |
| `wotw lint --fix` | Auto-heal common issues |
| `wotw stale` | Find pages that haven't been confirmed recently |
| `wotw candidates` | List pages awaiting approval |
| `wotw approve <file>` | Approve a candidate page into the wiki |
| `wotw reject <file>` | Reject a candidate with optional feedback |
| `wotw audit` | View the provenance chain |
| `wotw logs` | Tail the daemon log |

## Tips

- **Obsidian users**: This wiki is designed to work beautifully with
  [Obsidian](https://obsidian.md). Cross-references use `[[wikilinks]]` and
  the graph view shows how concepts connect.
- **Search**: Use `wotw search` for quick offline lookups. Use `wotw query`
  for deeper, LLM-powered answers.
- **Provenance**: Every page has a footer showing its sources. Click through
  to see exactly where information came from.
- **Health**: Run `wotw lint` periodically to find stale pages, broken links,
  and potential duplicates. Use `--fix` to auto-heal.

## Next Steps

1. Drop a few files into `raw/` and run `wotw start`
2. Browse the generated pages in `wiki/`
3. Try `wotw search` or `wotw query` to explore your knowledge
4. Check `wotw status` for a health overview

Happy knowledge building!
