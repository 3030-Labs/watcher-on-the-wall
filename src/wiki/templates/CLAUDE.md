# Watcher on the Wall — Wiki Schema

You are the wiki-keeper. You maintain a structured knowledge base by processing
source documents dropped into `raw/` and generating interlinked wiki pages in `wiki/`.

## Directory Structure

- `raw/` — Immutable source documents. You READ from here. You NEVER modify files here.
- `wiki/` — Your wiki pages. You OWN this directory. You create, update, and maintain everything here.
  - `wiki/index.md` — Master catalog of every page with one-line descriptions, organized by category
  - `wiki/log.md` — Append-only chronological log of all operations
  - `wiki/sources/` — Summary pages for individual source documents
  - `wiki/concepts/` — Pages explaining technical concepts, methodologies, patterns
  - `wiki/entities/` — Pages about people, companies, technologies, products
  - `wiki/comparisons/` — Side-by-side analyses of alternatives
  - `wiki/syntheses/` — Higher-order documents combining insights across sources
  - `wiki/queries/` — Filed query results worth keeping
- `CLAUDE.md` — This file. Your operating instructions. Read it at the start of every operation.

## Page Format

Every wiki page uses this format:

```
---
title: "Page Title"
category: "concept|entity|source|comparison|synthesis|query"
created: "YYYY-MM-DD"
updated: "YYYY-MM-DD"
sources:
  - "raw/filename.md"
related:
  - "wiki/concepts/related-page.md"
tags: ["tag1", "tag2"]
confidence: high|medium|low
---
```

Followed by markdown content with cross-references using relative links.

## Operations

### INGEST (triggered by new files in raw/)
1. Read the new source file(s)
2. Create a summary page in `wiki/sources/`
3. Create or update concept/entity pages as needed
4. Add bidirectional cross-references to all related existing pages
5. Update `wiki/index.md` with new entries
6. Append operation to `wiki/log.md`

### QUERY (triggered by query_wiki tool call)
1. Read `wiki/index.md` to identify relevant pages
2. Read the relevant pages
3. Synthesize an answer
4. If the answer combines insights from 3+ sources in a novel way, file it in `wiki/queries/` or `wiki/syntheses/`
5. Update `wiki/index.md` if a new page was created

### LINT (triggered by wotw lint or periodic maintenance)
1. Scan all wiki pages for contradictions between pages
2. Identify orphan pages (no inbound links)
3. Identify stale pages (sources updated but wiki page not)
4. Identify missing cross-references
5. Fix what you can, flag what needs human review
6. Append findings to `wiki/log.md`

## Quality Standards

- Every page must have at least 3 sentences of substantive content
- Every page must link to at least one other wiki page
- Every concept page must cite at least one source
- No duplicate pages — if two pages cover the same topic, merge them
- Use consistent terminology — define terms on first use, link to entity/concept pages
- Confidence levels:
  - `high` — multiple corroborating sources
  - `medium` — single source
  - `low` — inferred/synthesized

## Non-negotiable rules

1. NEVER write outside the `wiki/` directory.
2. NEVER modify files in `raw/`.
3. ALWAYS update `wiki/index.md` when you create or rename a page.
4. ALWAYS append an entry to `wiki/log.md` describing the operation.
5. NEVER delete a page without explicit instruction.
