# wotw Launch Prep — Review Document

**Date:** 2026-04-12
**Repo:** `/home/jgoodman/watcher-on-the-wall`
**Status:** All changes applied, all 5 gates green, ready to commit

---

## Changes At a Glance

| File | Action | What Changed |
|------|--------|-------------|
| `package.json` | Modified | name, description, author, homepage, repository, bugs, keywords, bin, files, engines, lint-staged config, husky prepare script |
| `.npmignore` | Modified | Comprehensive exclusion list (was 14 lines, now 47) |
| `README.md` | Rewritten | 161 lines → 74 lines. Paragraph-form features, 3-line install, all 10 docs linked |
| `CHANGELOG.md` | Modified | Added `0.2.0` section (Features / Security / Quality) |
| `.github/CODEOWNERS` | New | `* @OptionsIQ` |
| `.github/ISSUE_TEMPLATE/bug_report.md` | New | Version/node/OS fields, repro steps, log paste area |
| `.github/ISSUE_TEMPLATE/feature_request.md` | New | Use case / proposed solution / alternatives |
| `.github/pull_request_template.md` | New | What/Why/How + 5-gate checklist |
| `.husky/pre-commit` | New | Runs `npx lint-staged` |
| `LAUNCH-PREP.md` | New | Tracker (all items checked) |
| `pnpm-lock.yaml` | Modified | +husky 9.1.7, +lint-staged 16.4.0 |

---

## 1. package.json — Before / After

### Before
```json
{
  "name": "watcher-on-the-wall",
  "description": "A self-bootstrapping persistent AI knowledge daemon. Your AI agents share a brain. It builds itself.",
  "bin": {
    "wotw": "./dist/cli/index.js",
    "watcher-on-the-wall": "./dist/cli/index.js"
  },
  "files": ["dist", "templates", "README.md", "LICENSE", "CHANGELOG.md"],
  "keywords": ["ai", "llm", "claude", "mcp", "knowledge-base", "daemon", "wiki", "provenance", "compliance", "agent"],
  "author": "3030 Labs LLC",
  "engines": { "node": ">=20.0.0" }
}
```

### After
```json
{
  "name": "@driftvane/wotw",
  "description": "Self-bootstrapping AI knowledge daemon that turns a folder of raw files into a persistent, compounding LLM wiki with provenance signing, MCP serving, and zero manual maintenance.",
  "bin": {
    "wotw": "dist/cli/index.js"
  },
  "files": ["dist", "src/wiki/templates", "LICENSE", "README.md"],
  "keywords": ["llm-wiki", "knowledge-base", "obsidian", "mcp", "provenance", "ai-daemon", "knowledge-management", "claude", "markdown-wiki"],
  "author": "3030 Labs LLC <support@3030labs.io>",
  "homepage": "https://github.com/3030-Labs/watcher-on-the-wall",
  "repository": { "type": "git", "url": "https://github.com/3030-Labs/watcher-on-the-wall.git" },
  "bugs": { "url": "https://github.com/3030-Labs/watcher-on-the-wall/issues" },
  "engines": { "node": ">=20" },
  "lint-staged": {
    "src/**/*.ts": ["prettier --write", "eslint --fix"],
    "test/**/*.ts": ["prettier --write", "eslint --fix"]
  }
}
```

**Key decisions:**
- Dropped `watcher-on-the-wall` binary alias (only `wotw` now)
- `files` includes `src/wiki/templates` (used by `wotw init` at runtime; also copied to `dist/wiki/templates/` by tsup)
- Removed `CHANGELOG.md` from `files` (excluded by `.npmignore` `*.md` rule — keeps tarball lean)
- `prepare: "husky"` auto-added by `npx husky init`

---

## 2. README.md — Full Text (74 lines)

```markdown
# watcher-on-the-wall

> Self-bootstrapping AI knowledge daemon that turns a folder of raw files into
> a persistent, compounding LLM wiki with provenance signing, MCP serving, and
> zero manual maintenance.

## What it does

Drop files into a `raw/` directory and `wotw` watches for changes, batches them
through a Claude agent, and writes interlinked markdown wiki pages with YAML
frontmatter. Every operation is signed into an append-only SHA-256 provenance
chain so you can prove which model wrote what, from which inputs, at what cost.
The wiki is served to any MCP-capable client (Claude Code, Claude Desktop, IDEs)
and designed to use Obsidian as the visual frontend.

## Install

  npm i -g @driftvane/wotw
  wotw init
  wotw start

Drop files into `raw/`. The daemon ingests them, writes wiki pages, and serves
them to Claude Code via MCP.

## Key features

[3 paragraphs covering: daemon lifecycle, init wizard, candidates workflow,
BM25 search, NL queries, health scoring, auto-healing, provenance chain,
MCP server (10 tools), dual-mode runtime, multi-user auth, DLQ, redaction]

## How it works

[1 paragraph: watcher → queue → Claude → wiki → provenance → git → MCP →
compounding engine]

## CLI

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

## Documentation

[10 links to docs/ — architecture, configuration, cli-reference, mcp-tools,
provenance, execution-modes, knowledge-health, obsidian-setup, multi-user,
retrieval-hardening]

## Requirements

Node.js >= 20. Claude Code or an Anthropic API key.

## License

AGPL-3.0-or-later — 3030 Labs LLC

## Links

GitHub | Documentation | Contributing | Security
```

---

## 3. CHANGELOG.md — New 0.2.0 Section

```markdown
## [0.2.0] — 2026-04-12

### Features
- Interactive init wizard (wotw init): 7-step @clack/prompts wizard with
  Obsidian vault auto-detection, overlay support, and optional vault launch.
- Knowledge health system: 5-factor quality scoring
- Auto-healing (wotw lint --fix): 5 heal handlers
- Deletion handling: archive provenance type
- Lint scheduler: optional background lint runs
- Dead-letter queue: JSONL ledger for failed batches
- wotw logs command: tail daemon log with -f/--follow
- Retrieval hardening: LLM-powered query expansion, richer YAML metadata
- Candidates workflow: human review queue

### Security
- Timing-safe token comparison (crypto.timingSafeEqual)
- Canonical path validation (resolveWikiPath)
- No-auth safety rail on non-loopback hosts
- Eager provenance hashing
- Credential redaction (9 patterns)
- errMsg() replaced all 18 unsafe (err as Error).message casts
- Zero bare catch {} blocks

### Quality
- 446 tests across 51 files (up from 192/16 in 0.1.0)
- Deep verification audit: 36 findings all resolved with regression tests
- Two independent adversarial audits (V1: 16, V2: 13) all resolved
```

---

## 4. GitHub Templates

### `.github/ISSUE_TEMPLATE/bug_report.md`
Standard bug report: wotw version, Node version, OS, what happened, repro steps, expected vs actual, log paste block.

### `.github/ISSUE_TEMPLATE/feature_request.md`
Use case driven: what problem, proposed solution, alternatives considered.

### `.github/pull_request_template.md`
What/Why/How sections + checklist: 5 gates, tests, docs, no formatting noise, conventional commits.

### `.github/CODEOWNERS`
```
* @OptionsIQ
```

---

## 5. Pre-commit Hooks

- **husky** 9.1.7 — `.husky/pre-commit` runs `npx lint-staged`
- **lint-staged** 16.4.0 — on `src/**/*.ts` and `test/**/*.ts`: `prettier --write` then `eslint --fix`
- `prepare: "husky"` in package.json ensures hooks install on `pnpm install`

---

## 6. npm Tarball Contents (from `npm pack --dry-run`)

```
@driftvane/wotw@0.2.0 — 20 files, 441 KB packed

dist/cli/index.js          306.7 KB   (CLI bundle with shebang)
dist/cli/index.js.map      632.2 KB
dist/cli/index.d.ts        13 B
dist/daemon/entry.js       208.1 KB
dist/daemon/entry.js.map   461.9 KB
dist/daemon/entry.d.ts     13 B
dist/index.js              26.8 KB
dist/index.js.map          61.7 KB
dist/index.d.ts            17.6 KB
dist/wiki/templates/       4 files (CLAUDE.md, getting-started.md, index.md, log.md)
src/wiki/templates/        4 files (same — redundant safety copy)
LICENSE                    1.6 KB
README.md                  4.6 KB
package.json               2.8 KB
```

**NOT included:** `src/*.ts`, `test/`, `.github/`, `docs/`, `*.md` reports, `.husky/`, config files.

---

## 7. Verification Results

| Gate | Result |
|------|--------|
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS (0 errors, 7 warnings) |
| `pnpm format:check` | PASS |
| `pnpm test` | 446/446 passed across 51 files |
| `pnpm build` | PASS (CLI 299 KB, daemon 203 KB, index 26 KB) |
| `npm pack --dry-run` | 20 files, 441 KB, no leaks |
| `wotw --version` | `0.2.0` |
| `wotw --help` | All 16 commands listed |

---

## 8. What's Left (for you on launch day)

```bash
cd /home/jgoodman/watcher-on-the-wall

# Stage and commit
git add .npmignore CHANGELOG.md README.md package.json pnpm-lock.yaml \
  .github/CODEOWNERS .github/ISSUE_TEMPLATE/ .github/pull_request_template.md \
  .husky/ LAUNCH-PREP.md
git commit -m "chore: launch prep — npm publish readiness, README, GitHub templates, pre-commit hooks"

# Push (3 commits ahead of origin/main)
git push origin main

# Tag the release
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0

# Publish to npm (requires npm login to @driftvane scope)
npm publish --access public
```

---

## Decision Points for Your Review

1. **Package name `@driftvane/wotw`** — requires the `@driftvane` npm org to exist. If not created yet, you'll need `npm org create driftvane` or publish unscoped as `wotw`.

2. **CODEOWNERS uses `@OptionsIQ`** — confirmed this is your GitHub username on the 3030 Labs org.

3. **`watcher-on-the-wall` binary alias removed** — only `wotw` is exposed. The old name was redundant.

4. **`CHANGELOG.md` excluded from npm tarball** — the `.npmignore` `*.md` rule catches it. Only `README.md` and `LICENSE` ship. If you want CHANGELOG in the tarball, add it to `files` in package.json.

5. **`src/wiki/templates/` in tarball** — these are also in `dist/wiki/templates/` (copied by tsup). Double-included for safety since `wotw init` references them. ~8 KB total, negligible.
