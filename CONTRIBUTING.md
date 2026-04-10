# Contributing to watcher-on-the-wall

Thanks for considering a contribution. `wotw` is a small, opinionated
project — this document tells you how to build it, how to test it, and
what the bar is for a PR.

---

## Development setup

Requirements:

- Node.js ≥ 20 (LTS recommended)
- [pnpm](https://pnpm.io/) (this repo pins lockfiles to pnpm; npm/yarn
  will create a lockfile drift)

```bash
git clone https://github.com/3030labs/watcher-on-the-wall.git
cd watcher-on-the-wall
pnpm install
pnpm build
```

To run `wotw` from your local checkout:

```bash
pnpm link --global
wotw --version
```

---

## The quality gates

Every PR must pass the full gate sequence locally before it lands:

```bash
pnpm typecheck     # tsc --noEmit, zero errors
pnpm lint          # eslint, zero errors (warnings allowed)
pnpm format:check  # prettier, must be clean
pnpm test          # vitest, every test green
pnpm build         # tsup, produces dist/
```

These are all fast; the whole sequence runs in well under a minute on
modern hardware. Failing any gate blocks the PR — please don't open a
PR expecting a reviewer to help you pass them.

If you're touching a specific subsystem, the narrower test scripts are
helpful while iterating:

```bash
pnpm test:unit         # only test/unit/**
pnpm test:integration  # only test/integration/**
pnpm test:watch        # vitest watch mode
```

---

## Code standards

The rules are boring but strict. The TypeScript config is
`strict: true` with no loopholes:

- **No `any`.** Use `unknown` and narrow, or write a real type. If you
  genuinely need to escape the type system, prefer `as unknown as T`
  with a comment explaining why.
- **No `console.log`.** Logging goes through `getLogger("module-name")`
  from `src/utils/logger.ts`. Child loggers let us filter by subsystem.
- **ESM with `.js` extensions.** Internal imports must end in `.js`
  even though the source is `.ts`:
  ```ts
  import { WikiStore } from "../wiki/store.js"; // ✅
  import { WikiStore } from "../wiki/store";    // ❌
  ```
- **Atomic writes.** Any code that writes to the wiki store, cost log,
  provenance chain, or dead-letter queue writes to a temp file and
  renames. Never append-without-fsync; never partial-write.
- **Barrel imports.** Consume subsystems through their module entry
  (`src/wiki/store.ts`, `src/ingestion/queue.ts`) rather than reaching
  into private files.
- **Pure helpers go in `src/utils/`.** Subsystem-specific logic stays
  inside the subsystem directory.
- **Prefer composition over inheritance.** The codebase has ~zero class
  hierarchies; every `class` is a concrete implementation of a small
  interface (e.g., `DaemonSubsystem`) or a stateful holder like
  `WikiStore`.

Tests follow the same rules, plus:

- **One test file per source file.** `src/ingestion/queue.ts` ↔
  `test/unit/queue.test.ts` (or `test/integration/queue.test.ts` when
  the test exercises multiple subsystems together).
- **Real I/O via tmpdirs.** Unit tests that touch the filesystem use
  `mkdtempSync(join(tmpdir(), "wotw-..."))` — not mocks of `fs`.
- **Fake timers for schedulers.** Time-based code
  (`LintScheduler`, debounce) uses `vi.useFakeTimers()`.
- **No network.** Nothing in the test suite may make real HTTP calls
  to Anthropic or any other service. Injected mock runners only.

---

## Project layout

```
src/
  cli/           # commander entrypoints + per-command files
  daemon/        # Daemon class + entry.ts + LintScheduler
  ingestion/     # IngestionQueue, CostTracker, ModelRouter, DeadLetterQueue
  watcher/       # chokidar + adaptive debounce batcher
  wiki/          # WikiStore, Search, IndexManager, page helpers
  server/        # McpHttpServer + tool registry
  provenance/    # append-only SHA-256 hash chain
  compounding/   # synthesis engine
  multi-user/    # optional per-user token store
  utils/         # types, logger, fs helpers, sanitize
test/
  unit/          # one file per source file
  integration/   # cross-subsystem scenarios
docs/            # user-facing docs (docs/architecture.md is the starting point)
```

The architecture doc at [docs/architecture.md](docs/architecture.md)
is the quickest way into the code.

---

## What makes a good PR

**Good PRs are surgical.** One feature, one bug fix, one refactor —
not all three. If you find unrelated issues on the way, open a second
PR for them.

**Good PRs come with tests.** A new feature without tests won't be
merged. A bug fix should include a regression test that fails before
the fix and passes after.

**Good PRs update the docs.** If you change a config field, a CLI
flag, an MCP tool, or a subsystem's behavior, update the matching file
under `docs/`. The docs are the contract with users.

**Good PRs don't churn.** Please don't reformat files you aren't
editing. Please don't rename things "for clarity" as part of a feature
PR — a pure-rename PR is welcome, but mixing it with functional
changes makes the diff hard to review.

**Good PRs explain the "why."** The PR description should say what
problem you're solving, not just what code you changed. The diff
already shows the "what."

---

## Reporting security issues

**Do not open a public issue for security vulnerabilities.** See
[SECURITY.md](SECURITY.md).

---

## Licensing

`wotw` is licensed AGPL-3.0-or-later. By submitting a PR you agree
that your contribution is licensed under the same terms. If you need
a commercial-friendly dual license for your own deployment, open an
issue — we're open to discussing it, but the default is AGPL.
