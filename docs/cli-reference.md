# CLI reference

Every `wotw` command accepts `-h` / `--help` for inline usage, and
`-v` / `--version` on the top-level `wotw` command.

---

## `wotw init [dir]`

Interactive setup wizard, Obsidian-aware. Scaffolds a new vault (or
overlays `raw/` + `wiki/` inside an existing Obsidian vault), detects
the runtime (Claude CLI vs API key), and optionally launches the
result in Obsidian on completion.

```bash
wotw init                # interactive wizard
wotw init ./my-vault     # explicit vault path (positional)
wotw init -p ./my-vault  # same, long flag
wotw init --yes          # non-interactive, accept defaults, use cwd
wotw init --no-open      # skip the "open in Obsidian" step
wotw init --force        # overwrite an existing scaffold
```

### Flags

| Flag | Description |
|------|-------------|
| `[dir]` | Positional vault path. Overrides auto-detect. |
| `-p, --path <dir>` | Same as the positional — explicit vault path. |
| `-y, --yes` | Skip all prompts, accept defaults. |
| `--no-open` | Do not launch Obsidian on completion. |
| `-f, --force` | Overwrite an existing scaffold (bypass idempotency check). |

### Wizard flow

1. **Intro** — brief banner.
2. **Idempotency check** — if the target directory is already a fully
   scaffolded wotw vault, the wizard short-circuits with a "nothing to
   do" note and exits 0.
3. **Vault location** — reads the Obsidian registry (`obsidian.json`)
   on your platform and offers a menu of detected vaults, plus
   "create a new vault here" and "enter a custom path".
4. **Overlay detection** — if the chosen path already contains
   `.obsidian/`, the wizard asks whether to create `raw/` + `wiki/`
   at the vault root or inside a subdirectory (default: `wotw`).
5. **Runtime detection** — silently looks for a `claude` CLI binary on
   PATH, then falls back to `ANTHROPIC_API_KEY`. Prints a warning if
   neither is found.
6. **Scaffold** — creates `raw/`, `wiki/{index.md, log.md,
   concepts/, entities/, sources/, comparisons/, syntheses/,
   queries/}`, `CLAUDE.md`, `wotw.yaml` with sibling `raw_path` /
   `wiki_root`, `.gitignore` (append-or-create), and `.git/` with an
   initial commit. For fresh vaults (no pre-existing `.obsidian/`) it
   also writes minimal `.obsidian/{app.json, appearance.json,
   graph.json}` defaults.
7. **Open in Obsidian** — asks to launch the vault via the
   `obsidian://open` URI. On failure (Obsidian not installed) the
   wizard prints a friendly fallback note.
8. **Next steps** — prints a short "what to do next" panel.

### Non-interactive mode

When stdin is not a TTY, or `--yes` is passed, every prompt is
skipped:

- Vault path defaults to `--path`, else the positional `[dir]`, else
  `process.cwd()`.
- Obsidian overlay is never used — the scaffold lives at the chosen
  vault root.
- Obsidian is never launched.

This is the mode CI systems and scripts should use.

### Idempotency

Re-running `wotw init` against an already-initialized vault verifies
the structure (config file, `raw/`, `wiki/` with all category subdirs)
and exits 0 without touching any files. Use `--force` if you need to
rewrite templates from scratch.

See [obsidian-setup.md](./obsidian-setup.md) for the full Obsidian
integration guide.

---

## `wotw start`

Spawn the daemon as a detached child process (via `child_process.spawn`
with `detached: true` and `stdio: 'ignore'`) and exit. The daemon writes
its PID to `daemon.pid_file` and its log to `daemon.log_file`.

```bash
wotw start              # detach
wotw start --foreground # run in foreground (useful under systemd / docker)
```

## `wotw stop`

Send `SIGTERM` to the running daemon (read from `daemon.pid_file`) and
wait for it to exit.

## `wotw status [--watch] [--json]`

Print a snapshot of the daemon: uptime, queue depth, last-ingest
summary, today's cost, wiki page counts, provenance head, orphaned
page count, and failed-batch count from the dead-letter queue.

```bash
wotw status --watch  # live-refreshing TUI
wotw status --json   # machine-readable
```

## `wotw logs [-n <count>] [-f|--follow]`

Tail the daemon log file (`daemon.log_file` from your config).
Without flags, prints the last 20 lines and exits — useful for a
quick "did the daemon start cleanly?" check.

```bash
wotw logs                    # last 20 lines
wotw logs -n 200             # last 200 lines
wotw logs --follow           # stream new lines as they arrive
wotw logs -f                 # same
```

In follow mode, the command polls the log file every 250ms (robust
on WSL and other environments where inotify is flaky) and prints new
bytes as they appear. If the log is rotated out from under the
follower (size shrinks), the offset resets so you pick up the new
file cleanly. Exit with `Ctrl+C`.

If the configured log file does not yet exist (the daemon has never
run, or it was deleted) the command prints a friendly "no log file
at …" message and exits 0.

---

## `wotw query <question> [--k N] [--json]`

Ask a natural-language question and print an answer grounded in the
wiki, with inline `[citation]` markers.

```bash
wotw query "what is a hash chain?"
wotw query "decisions about auth" --k 12 --json
```

`--k` controls how many wiki pages are retrieved as context.

## `wotw audit [--limit N] [--json] [--full]`

Walk the provenance chain and verify its integrity.

- Without `--full`, only the last `N` records are walked.
- `--full` verifies every record from genesis.
- Non-zero exit code on any tamper detection.

## `wotw lint [--fix] [--yes] [--json]`

Run a health check over every wiki page. Computes per-page health
scores (staleness, source availability, link health, duplicate risk,
contradiction risk) and emits structured findings (stale pages, broken
links, orphans, duplicates, missing backlinks).

```bash
wotw lint              # report only — no changes to disk
wotw lint --json       # machine-readable JSON output
wotw lint --fix        # heal auto-fixable findings (prompts for confirmation)
wotw lint --fix --yes  # heal without prompting
```

### Flags

| Flag | Description |
|------|-------------|
| `--fix` | Dispatch auto-fixable findings to heal handlers (LLM-powered for stale/duplicate/broken-link/contradiction; deterministic for missing-backlink). |
| `--yes` | Skip confirmation prompt when `--fix` is set. |
| `--json` | Output the health report as JSON instead of formatted text. |

### Heal handlers

When `--fix` is used, each finding is dispatched to a specialized
handler. LLM-powered handlers check the cost budget before invoking
and produce `type: "heal"` provenance records. The number of fixes
per run is capped by `health.max_fixes_per_run` (default 10).

See [knowledge-health.md](./knowledge-health.md) for the full health
system documentation.

## `wotw synthesize [--force]`

Trigger a compounding synthesis pass immediately. Normally compounding
runs on a timer in the background; this is for manual/triggered runs.

- `--force` ignores the "wiki too small" check.

## `wotw serve [--port N] [--host H]`

Run the MCP server only (no watcher, no ingestion). Useful when you want
to use `wotw` as a pure read-only knowledge server over an existing wiki
that another process populates.

---

## `wotw user <subcommand>`

Manage per-user authentication tokens. Requires
`multi_user.enabled: true` in the config.

### `wotw user add <name>`

Issue a new bearer token for a user. Prints the token once; save it
immediately, it is not stored in plaintext anywhere and cannot be
recovered.

```bash
wotw user add alice
# Issued token for alice.
#
# Token (save this — it will not be shown again):
#   wotw_a1b2c3d4…
#
# Configure clients with `Authorization: Bearer <token>`.
```

Issuing a new token for a user who already has one revokes the
previous token.

### `wotw user list [--json]`

List active users with token creation times.

### `wotw user revoke <name>`

Revoke every token for a user. Does not require the daemon to be
running; edits `workspaces_dir/tokens.json` directly.

---

## `wotw install-hook` / `wotw uninstall-hook`

Install or remove a git `post-commit` hook in the wiki repo that
triggers an ingestion pass on every commit. Useful when you're editing
wiki pages directly in your editor instead of dropping raw files.

---

## Exit codes

| Code | Meaning |
|----|----|
| 0 | Success |
| 1 | Generic failure |
| 2 | Config error |
| 3 | Daemon not running (for commands that require it) |
| 4 | Provenance verification failed (`wotw audit`) |
