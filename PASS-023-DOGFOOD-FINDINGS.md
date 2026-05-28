# PASS-023 — Dogfood Findings

**Date:** 2026-05-27 / 2026-05-28
**Operator:** Justin Goodman
**Machine:** MacBook Air, **Intel x86_64** (genuine — `uname -m` = `x86_64`,
not Apple Silicon under Rosetta), macOS, **Node v24.13.0** (via nvm),
**pnpm v11.3.0**, Claude Code CLI v2.1.17 at `/usr/local/bin/claude`.
**Repo state:** `DriftVane/watcher-on-the-wall` @ v0.8.4 (commits e36de03 +
12dd63d), installed from source (npm package not yet published).

This is the item-15 dogfood pass: a real user installing + running `wotw`
on a machine that hadn't touched it. The walk surfaced **24 findings**.
The headline confirms the 3030 Labs principle that motivated PASS-023:
**the substrate is excellent; the onboarding shell was not.**

Once the daemon actually ran, the output was genuinely high-quality —
30 candidate pages synthesized from 5 source notes, correct YAML
frontmatter, `[[wiki-links]]`, a knowledge graph (concepts / entities /
comparisons), a clean 76-record provenance chain, `model=user` attribution
on human approvals. Everything before "the daemon actually ran" was a
gauntlet.

---

## Severity + status legend

- **P0** — blocks a stranger from getting to a working daemon.
- **P1** — misleading / confusing, but a determined user gets through.
- **P2** — polish.
- ✅ FIXED THIS PASS — committed in the v0.8.4 fix batch.
- 🟡 ASSUMED-NA-PENDING-NPM — believed not to affect the canonical
  `npm install -g @driftvane/wotw` path; cannot confirm until publish +
  clean-machine validation (deferred — see PASS-023 closure).
- ⏳ DEFERRED — real, but parked for a later pass.

---

## Bucket A — pnpm-from-source-install only (13 findings)

**The whole pnpm 10/11 chain.** These bit the dogfood *only* because the
npm package wasn't published yet, so the install was from source via
`pnpm link --global`. The canonical `npm install -g @driftvane/wotw` path
does not use pnpm's global content-addressable store and runs postinstall
scripts by default, so it is **believed immune to all of these** — but
that belief is UNVALIDATED until first publish.

| # | Finding | Sev | Status |
|---|---|---|---|
| 1 | `pnpm install` aborts with `ERR_PNPM_IGNORED_BUILDS` — native build scripts (`better-sqlite3`, `esbuild`, `@anthropic-ai/claude-code`) ignored by default; requires `pnpm approve-builds`. | P0 | 🟡 + ✅ (README) |
| 2 | After a fresh pnpm, `PNPM_HOME/bin` not on `$PATH` → `pnpm link` global bin unreachable until `pnpm setup` + shell reload. | P0 | 🟡 + ✅ (README) |
| 3 | `pnpm.onlyBuiltDependencies` in `package.json` is **silently ignored by pnpm 10+** (`The "pnpm" field in package.json is no longer read`). The repo's existing allowlist did nothing. | P0 | 🟡 |
| 4 | `pnpm link --global` syntax changed in pnpm 10 — now requires a positional `<dir>` (`pnpm link --global .`). Error message doesn't suggest the fix. | P1 | 🟡 + ✅ (README) |
| 5 | `pnpm link --global .` triggers a full `node_modules` recreation, which loses prior build approvals → re-approval loop. | P0 | 🟡 |
| 6 | Build approvals don't persist across recreations (the allowlist field is ignored, #3). | P0 | 🟡 |
| 7 | `pnpm link --global` (no dir) error message is opaque; invites muscle-memory failure. | P2 | 🟡 |
| 8 | The README's original "gap-window fallback" (`pnpm install && pnpm build && pnpm link --global`) shipped strangers straight into this entire trap. | P0 | ✅ (README rewritten to `npm install -g .`) |
| 14 | `pnpm link --global .` installs the package's deps into the **global pnpm store**, and `pnpm approve-builds` run in the project dir doesn't propagate there — native bindings unreachable at runtime even though the project-local `.pnpm/` had them. | P0 | 🟡 |
| 15 | PATH-precedence trap: a direct symlink in `/usr/local/bin/` doesn't override the leftover pnpm bin shim (`PNPM_HOME/bin` is ahead on `$PATH`). | P1 | 🟡 |
| 16 | pnpm 11 resolves `node_modules/<pkg>` straight to the global store via symlink, bypassing the project-local `.pnpm/` where postinstall artifacts were written. | P0 | 🟡 |
| 17 | **Root cause of #14-16:** `pnpm link --global .` injects `"@driftvane/wotw": "link:"` into the project's own `package.json` dependencies. That self-reference is what routes deps through the global store — and it also makes a later `npm install` fail (`EUNSUPPORTEDPROTOCOL "link:"`). | P0 | 🟡 + ✅ (README warns) |
| 19 | The pnpm-installed `claude` (`~/Library/pnpm/bin/claude`) hit the **same** native-binary trap — its bundled `@anthropic-ai/claude-code` postinstall hadn't run, so `claude --version` errored. wotw spawned it and got "claude native binary not installed". | P0 | 🟡 (use a non-pnpm `claude`) |

**Bucket A resolution:** the README from-source instructions now use
`npm install -g .` and explicitly warn against `pnpm link --global` for
native-dep packages. The deeper pnpm-store fixes (#3 allowlist migration,
etc.) are 🟡 — only relevant to contributors who insist on pnpm, and the
canonical npm path sidesteps them. **Must be re-validated against the
published package** (deferred).

---

## Bucket B — already fixed earlier this pass (2 findings)

| # | Finding | Sev | Status |
|---|---|---|---|
| 12 | `wotw init` scaffolds `wotw.yaml` but cosmiconfig only searched `wotw.config.*` → every fresh vault ran with all-defaults + crashed. | P0 | ✅ (commit 12dd63d — added `wotw.yaml`/`.yml` to searchPlaces) |
| 13 | `Daemon child exited prematurely with code 1` gave no pointer to the real cause. | P1 | ✅ (commit 12dd63d — error now names the log file + `--foreground`) |

---

## Bucket C — cross-cutting code bugs, every user (6 findings)

These hit regardless of install method. **All fixed this pass.**

| # | Finding | Sev | Status |
|---|---|---|---|
| 9 | `wotw init` — pressing Escape on the final "Open in Obsidian?" prompt prints `Cancelled.` and aborts, even though the scaffold already completed. Looked like total failure. | P1 | ✅ (Escape on the post-scaffold prompt = "skip open", proceeds to success) |
| 18 | `wotw start --foreground` ran a **stub daemon** — `new Daemon()` with ZERO subsystems registered. It "started" but ingested nothing, while detached mode (`entry.js`) wired everything. A foreground smoke test was meaningless. | P0 | ✅ (foreground now spawns the same fully-wired `entry.js`, attached to the terminal, `WOTW_LOG_STDOUT=1` for live logs) |
| 21 | Claude Code CLI 401 (not logged in) surfaced as `agent produced zero pages — marking batch as skipped` with the 401 buried in a log line. No prompt to run `claude /login`. | P0 | ✅ (detect CLI auth-failure signature → loud actionable error + dead-letter record; extends error-audit item #4) |
| 23 | `wotw status` reported `provenance records: 0` after a 76-record chain. `status.ts` re-joined `wikiRoot` with an already-absolute `chain_file` → double-prefixed nonexistent path → silent 0. | P1 | ✅ (use the resolved absolute path directly) |
| 24 | `wotw approve candidates/sample-1.md` failed "Candidate not found" but `wotw approve sample-1.md` worked — and the error even listed `sample-1.md` as available. `wotw candidates` + `wotw audit` both display the `candidates/` prefix, so copy-paste hit the error. | P1 | ✅ (strip leading `candidates/` in approve + reject) |
| (10) | `~/wotw-dogfood/wiki/` typed without `ls` → zsh "permission denied". **Not a wotw bug** — shell typo. Logged for completeness; no action. | — | n/a |

---

## Bucket D — doc fixes (2 findings)

| # | Finding | Sev | Status |
|---|---|---|---|
| 22 | README quickstart implied dropped files become wiki pages directly; it elided the `candidates/` → `wotw approve` → `wiki/` human-review step. A user watches `wiki/` and sees nothing. | P1 | ✅ (quickstart now shows the candidates→approve flow + the `ingestion.staging:false` auto-approve option) |
| 11 | `docs/init-walkthrough.md` described a `.wotw/config.yaml` layout that never matched the scaffold (real: `wotw.yaml` + `CLAUDE.md` at vault root, `candidates/` top-level). | P1 | ✅ (layout section corrected) |
| 20 | Claude Code CLI requires `claude /login` before wotw can use it in CLI runtime — not mentioned anywhere a first-timer would see. | P1 | ✅ (covered by #21's actionable error + docs/self-hosted-byok.md) |

---

## What worked (the "substrate excellent" half)

Once past the install shell, every substrate capability worked on the
first real run:

- **Ingestion + compounding:** 5 source notes → 30 candidate pages. The
  agent synthesized concept pages (`sourdough-fermentation`,
  `antifragility`, `vector-databases`), an entity (`nassim-taleb`), and
  comparisons (`long-context-vs-rag`) that weren't 1:1 with the inputs.
- **Wiki page quality:** correct YAML frontmatter (title, category,
  sources, related, tags, confidence, provenance block), real
  `[[wiki/concepts/maillard-reaction.md|...]]` internal links, substantive
  prose — not slop.
- **Provenance chain:** 76 records, clean `wotw audit` walk, distinct
  `ingest` vs `fact_extracted` record types, `model=claude-sonnet-4-5` on
  agent writes and `model=user cost=—` on human approvals.
- **Approval flow:** `wotw approve` correctly promoted a candidate into
  `wiki/sources/sample-1-sandbox-sourdough-notes.md`, appended a
  user-attributed provenance record, and git-committed.
- **MCP server:** bound cleanly, with the unauthenticated-localhost
  warning firing exactly as designed.
- **Error messages (post-fix):** the daemon-log pointer (#13 fix) is what
  made the native-binding root-cause findable at all.

The friction was **entirely** in: package-manager interaction (pnpm 11),
native-dependency postinstall, and CLI authentication — the "shell," not
the "substrate." That is precisely the gap PASS-023 set out to close.

---

## Carried into the v0.8.4 fix batch

Fixed + committed (this pass, no publish): #8, #9, #11, #12, #13, #18,
#21, #22, #23, #24. Tests added for #21, #23, #24, #9, #18 paths; full
7-gate run green.

## Deferred (see PASS-023-DAEMON-PUBLIC-READINESS.md "DEFERRED TO NEXT PASS")

- All 🟡 Bucket A items — re-validate against the **published** package on
  a clean machine. The canonical `npm install -g @driftvane/wotw` path is
  *believed* immune but is unproven until publish.
- npm publish v0.8.4 itself (gated on the DriftVane → 3030-Labs org move).
- 4-platform install-evidence capture (needs the published package).
