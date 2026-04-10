# Feature Pass 002

**Date:** 2026-04-09
**Scope:** Obsidian-aware interactive `wotw init` wizard.
**Baseline:** `watcher-on-the-wall` v0.1.0 post-Audit-V2-HIGH (252 tests across 24 files, 62 source files, ~8,820 source LoC).
**Outcome:** All 5 quality gates green. **272 tests across 26 files (Δ +20)**, **63 source files**, ~9,609 source LoC.

---

## Feature shipped

| # | Feature | Summary | Key files |
|---|---------|---------|-----------|
| 1 | Obsidian-aware interactive init | `wotw init` is now a 7-step @clack/prompts wizard: intro banner → idempotency check → vault location (auto-detects Obsidian vaults from `obsidian.json`, plus "create new" and "custom path") → overlay detection (existing `.obsidian/` → inline vs subdir) → silent runtime detection (claude CLI vs ANTHROPIC_API_KEY) → scaffold with spinner → optional launch via `obsidian://open` URI → next-steps panel. Non-interactive mode (no TTY, `--yes`, or `nonInteractive: true`) skips every prompt, uses `--path`/positional/cwd, and never touches Obsidian. Fresh vaults get minimal `.obsidian/{app,appearance,graph}.json` defaults; overlay into existing vaults never touches the `.obsidian/` directory. Idempotent re-runs short-circuit with a "nothing to do" note. `--force` overwrites templates but preserves user `.obsidian/` content. | `src/cli/commands/init.ts` (rewritten, ~780 LoC) · `src/cli/lib/vault-detect.ts` (new, ~190 LoC) · `src/wiki/templates/index.md` (rewritten with sentinel block) · `test/unit/vault-detect.test.ts` (new, 10 tests) · `test/unit/init-wizard.test.ts` (new, 10 tests) |

### Design notes

**Choice encoding in `promptForVaultPath`.** Clack's `Option<Value>[]` type
distributes over non-primitive union `Value` types, which breaks a
discriminated-union `Choice = { kind: "vault" | "cwd" | "custom" }` value.
The wizard sidesteps this by encoding each select option's value as a
short string id (`vault:<idx>`, `cwd`, `custom`) and decoding it back
into the typed `Choice` via a tiny `decodeChoice(id, vaults)` helper
after the prompt returns. This is the idiomatic clack pattern and keeps
the option array typing trivially `{ value: string; label; hint? }[]`.

**`wiki_root` semantics preserved.** The spec suggested
`wiki_root: ./wiki` but the existing `WikiStore` uses
`join(wikiRoot, "wiki")` — so `wiki_root` is the PARENT of the `wiki/`
subdirectory, not the subdirectory itself. The wizard writes
`wiki_root: .` so the store finds `./wiki/` at the vault root. No
changes needed to `src/daemon/config.ts`.

**Lowercase sentinel markers.** The starter `wiki/index.md` uses
`<!-- wotw:index:start -->` / `<!-- wotw:index:end -->` to match the
existing `src/wiki/index-manager.ts`, which does a case-sensitive
search on the lowercase form. Upper-casing them would silently break
auto-index maintenance on fresh vaults.

**Timing-safe launch dispatch.** `openInObsidian(vaultPath)` uses
`exec` with a 5000ms timeout and shell-quoted args (single-quote POSIX
escape / double-quote cmd.exe), always returns a boolean, and never
throws — so wizard step 6 degrades cleanly when Obsidian isn't
installed or the URI handler isn't registered.

**`.gitignore` append-or-create.** If no `.gitignore` exists at the
vault root, the wizard writes a full one including Obsidian
device-specific exclusions + wotw state + OS noise. If an existing
`.gitignore` already mentions `.wotw/` or `# wotw`, the wizard leaves
it strictly alone. Otherwise it appends a `# wotw daemon state` block
with a leading separator if the existing file doesn't end in a
newline. This is covered by three tests in `init-wizard.test.ts`.

**Fresh-vault `.obsidian/` defaults.** Written only when
`!existsSync(.obsidian)`: purple `#7c3aed` accent color,
`raw/assets` as the default attachment folder, and graph.json color
groups for `path:wiki/sources`, `path:wiki/syntheses`, `path:raw`.
Never touched on overlay — Obsidian owns that directory after first
launch.

**Idempotency check.** Walks:
1. `existsSync(vaultPath) && statSync.isDirectory()`
2. At least one file from `CONFIG_CANDIDATES` (matches cosmiconfig's
   searchPlaces: `wotw.yaml`, `.wotwrc.yaml`, etc.)
3. `raw/` and `wiki/` subdirectories
4. All 6 `WIKI_CATEGORY_DIRS` under `wiki/`

Any missing element → `{ initialized: false }`, wizard proceeds
normally. Full structure → short-circuit with `alreadyInitialized:
true` and a `p.note` + `p.outro` (interactive) or `info()` (non-
interactive). Tested by the "re-running is a no-op" case which
mutates `wiki/index.md` between the two runs and verifies the
mutation survives.

---

## Documentation

**New file:**

- `docs/obsidian-setup.md` (new, 122 LoC) — full Obsidian integration
  guide. Covers registry file locations (macOS / Windows / Linux /
  WSL), overlay vs fresh vault, subdirectory overlay semantics,
  `.gitignore` append rules, launcher dispatch per platform, and
  troubleshooting ("no vaults detected", wrong XDG_CONFIG_HOME, moved
  vault paths).

**Updates to `docs/`:**

- `docs/cli-reference.md` — `wotw init` section fully rewritten:
  new flag table (`[dir]`, `-p/--path`, `-y/--yes`, `--no-open`,
  `-f/--force`), 8-step wizard flow, non-interactive mode, idempotency
  guarantees, cross-link to `obsidian-setup.md`.

**Updates to `README.md`:**

- Quickstart updated: `wotw init` shown as interactive by default,
  `--yes` shown as the non-interactive alternative, `raw/notes.md`
  replaces the now-incorrect `wiki-store/raw/notes.md` path, new
  paragraph linking to `docs/obsidian-setup.md`.

---

## New dependency

- `@clack/prompts@^1.2.0` — interactive CLI primitives (intro, outro,
  text, select, confirm, spinner, note, isCancel, cancel, log). Pure
  production dependency. Adds ~15 KB to the CLI bundle.

---

## Quality gates

```bash
$ pnpm typecheck
tsc --noEmit        # 0 errors

$ pnpm lint
eslint src test --ext .ts   # 0 errors, 0 warnings

$ pnpm format:check
prettier --check "src/**/*.ts" "test/**/*.ts"
All matched files use Prettier code style!

$ pnpm test
 Test Files  26 passed (26)
      Tests  272 passed (272)
   Duration  ~11.5s

$ pnpm build
ESM dist/index.js             20.89 KB
ESM dist/cli/index.js        215.08 KB   (was ~200 KB)
ESM dist/daemon/entry.js     140.53 KB
ESM ⚡️ Build success in 93ms
DTS ⚡️ Build success in 3850ms
```

Test-count delta: **252 → 272** (+20: 10 in `vault-detect.test.ts`, 10
in `init-wizard.test.ts`). File-count delta: src 62 → 63 (+1
`src/cli/lib/vault-detect.ts`), test 24 → 26 (+2). CLI bundle delta:
~200 KB → ~215 KB (+15 KB from @clack/prompts + new init.ts).

---

## Files changed

### New
- `src/cli/lib/vault-detect.ts` (188 LoC) — Obsidian registry parser, enclosing-vault walker, launcher helper
- `test/unit/vault-detect.test.ts` (154 LoC) — 10 tests
- `test/unit/init-wizard.test.ts` (187 LoC) — 10 tests
- `docs/obsidian-setup.md` (122 LoC)
- `FEATURE-PASS-002.md` (this file)

### Modified
- `src/cli/commands/init.ts` — rewritten as a 7-step interactive wizard (~780 LoC, was ~160 LoC)
- `src/wiki/templates/index.md` — new starter content with sentinel block and `__WOTW_UPDATED_ISO__` placeholder
- `docs/cli-reference.md` — `wotw init` section rewritten
- `README.md` — Quickstart updated
- `package.json` — `@clack/prompts: ^1.2.0` added
- `BUILD-SUMMARY.md` — headline numbers refreshed (63 src / 26 test / 272 tests)

---

## Verification commands

```bash
# 1. New utility exists and its tests pass
pnpm vitest run test/unit/vault-detect.test.ts

# 2. Wizard integration tests pass (non-interactive path)
pnpm vitest run test/unit/init-wizard.test.ts

# 3. Non-interactive scaffolding still produces a working vault
rm -rf /tmp/wotw-smoke && mkdir /tmp/wotw-smoke
node dist/cli/index.js init /tmp/wotw-smoke --yes --no-open
ls /tmp/wotw-smoke/{wotw.yaml,CLAUDE.md,.gitignore,raw,wiki/index.md}
ls /tmp/wotw-smoke/wiki/{concepts,entities,sources,comparisons,syntheses,queries}
ls /tmp/wotw-smoke/.obsidian/{app,appearance,graph}.json

# 4. Idempotent re-run exits 0 without touching files
echo MUTATED > /tmp/wotw-smoke/wiki/index.md
node dist/cli/index.js init /tmp/wotw-smoke --yes --no-open
cat /tmp/wotw-smoke/wiki/index.md   # still "MUTATED"
```
