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
git clone https://github.com/DriftVane/watcher-on-the-wall.git
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

## The 7 quality gates

Every PR must pass the full gate sequence locally before it lands.
This is non-negotiable; CI runs the same checks on every push, and a
PR that's red on any gate is auto-deferred. The gates are:

| # | Command | Bar |
|---|---|---|
| 1 | `pnpm typecheck` | Zero TypeScript errors. Strict mode is non-negotiable. |
| 2 | `pnpm lint` | Zero ESLint errors. Warnings allowed but please clean any you introduce. |
| 3 | `pnpm format:check` | Prettier clean. Use `pnpm format` to auto-fix locally. |
| 4 | `pnpm test` | Every test green. 900+ tests; full suite runs in <90 seconds. |
| 5 | `pnpm build` | `tsup` produces `dist/` without errors or warnings. |
| 6 | Docs in sync | If you changed a CLI flag, config field, MCP tool, or env var, the matching `docs/` file is updated in the same PR. |
| 7 | Provenance compat | If you touched `src/provenance/`, `src/utils/types.ts` canonical-payload, or anything observable in `chain.jsonl`, you ran the cross-runtime byte-identity test against `wotw-verify`. See [`docs/pack-format-daemon.md`](docs/pack-format-daemon.md). |

Gates 1-5 are the "build gates" and are fully automated; gates 6 + 7
are PR-review-time gates. Failing any gate blocks the PR — please
don't open a PR expecting a reviewer to help you pass them.

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
[SECURITY.md](SECURITY.md) for the disclosure process and SLA.

---

## PR review expectations

Once a PR is open and the build gates are green:

- **Triage**: a maintainer (currently `@OptionsIQ`) acknowledges within
  3 business days. Larger contributions or design-impacting changes may
  take longer to evaluate.
- **First review**: substantive feedback within a week of triage.
  Smaller PRs (bug fixes with clear regression tests, doc updates,
  surface-area-stable improvements) move faster.
- **Iteration**: reviewer leaves a single batch of comments, you
  address them, request re-review. Avoid pushing dozens of fixup
  commits — squash before requesting re-review.
- **Merge**: squash-merge with the PR title as the commit message.
  Maintainer-only.

If a PR sits without acknowledgement for more than two weeks, ping
the maintainer in a polite comment. We're a small team and PRs
occasionally get buried.

**What gets accepted quickly**: bug fixes with regression tests, doc
improvements, narrow refactors that preserve behavior, performance
improvements with benchmarks, security fixes.

**What gets discussed first**: anything that changes the MCP tool
surface, the provenance-chain format, the wiki-store layout, the
config schema, or the public CLI flags. Open an issue first to align
on the design; an out-of-band PR can be more work to merge than to
not merge.

**What's likely to be declined**: anything that violates the design
principles in [LICENSE-NOTICES.md](LICENSE-NOTICES.md) (local-first,
BYOK, BM25-only retrieval, AGPL-compatible), or that introduces a
dependency on a SaaS we don't control (a vector database, a cloud
search service, a paid analytics SDK, etc).

---

## Licensing + DCO sign-off

### The licence

`wotw` is licensed [**AGPL-3.0-or-later**](LICENSE). Read
[LICENSE-NOTICES.md](LICENSE-NOTICES.md) for the plain-English
summary of what that means — particularly the §13 network-use clause
which makes AGPL meaningfully different from GPL.

By submitting a PR you agree:

1. Your contribution is licensed under AGPL-3.0-or-later, identical
   to the rest of the codebase.
2. You have the legal right to contribute the code you're submitting —
   you wrote it yourself, or you have permission from the rights
   holder (employer, prior collaborator, etc).
3. You understand that 3030 Labs LLC also offers commercial licences
   of `wotw` to third parties (see [LICENSE-NOTICES.md](LICENSE-NOTICES.md)).
   Your contribution will be available under those commercial licences
   too, on the same terms 3030 Labs offers to other licensees. **This
   is not a CLA giving 3030 Labs special rights** — it follows from
   the AGPL's symmetric grant. If this is unworkable for you, open an
   issue before contributing and we'll discuss.

### The DCO sign-off

We use the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) — the same single-sentence affirmation the Linux kernel and
most large AGPL/GPL projects use. **We do NOT require a separate CLA;
the DCO is the entire contributor agreement.**

Every commit on a PR must carry a `Signed-off-by:` trailer matching
the commit's author. To do this automatically, configure git and use
the `-s` / `--signoff` flag:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
git commit -s -m "fix(ingestion): handle EACCES on wiki write"
```

The resulting commit message looks like:

```
fix(ingestion): handle EACCES on wiki write

Description...

Signed-off-by: Your Name <you@example.com>
```

If you forget the sign-off, amend the commit (`git commit --amend -s`)
and force-push your PR branch. CI will refuse to merge a PR whose
commits lack the trailer.

### What the DCO certifies

By signing off, you are stating (in the DCO's own words):

- The contribution was created in whole or in part by you, **and** you
  have the right to submit it under the open-source licence indicated
  in the file (AGPL-3.0-or-later); **or**
- The contribution is based on previous work that, to the best of your
  knowledge, is covered under an appropriate open-source licence, and
  you have the right to submit it (modified or unmodified) under the
  same licence; **or**
- The contribution was provided directly to you by someone who
  certified the above and you have not modified it.

You also acknowledge that the contribution + your sign-off are public,
recorded, and that you retain copyright in your contribution.

For corporate contributors: if your employer claims copyright over
work you do (even outside hours), please get their written sign-off
before contributing — usually a one-line email from your manager
saying "this contribution is yours to make" is enough. We don't
police this aggressively, but if a copyright dispute arises later,
the DCO sign-off is what we point to.

### Bot-generated PRs

PRs generated by automated tooling (Dependabot, Renovate, Claude
Code, Codex, etc.) need a sign-off from the human who reviewed and
approved the bot's output before opening the PR. The bot's commits
should carry a sign-off attributing the work to that human; a
co-authored-by trailer for the bot is welcome but not required.

We currently do not accept PRs that are entirely autonomous (no
human review or sign-off). Tooling-assisted contributions where a
human is the responsible party are welcome.

---

## A note on test count

The project currently ships 900+ tests across unit / integration /
e2e tiers. The number itself is not a target — but a downward
trajectory is a red flag. If you remove tests, the PR must explain
why: usually "this tested behavior that no longer exists" or
"this was a duplicate of test X." Never "this test was flaky" — fix
the flake, don't delete the signal.

---

## Thanks

This project benefits from anyone willing to read code, file issues,
write tests, or push back on bad design. We try to take feedback well
and credit contributors clearly. If something about the contributor
experience feels off — slow review, unclear feedback, missing context
in code — open an issue and tell us. That's also a contribution.
