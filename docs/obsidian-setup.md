# Obsidian setup

`watcher-on-the-wall` is plain-markdown-first: your wiki is a folder
of `.md` files with `[[wikilinks]]` and YAML frontmatter, and it works
without any GUI. But because Obsidian speaks exactly this format, we
treat it as the reference reader and make the `wotw init` wizard
Obsidian-aware from the first run.

This document covers the Obsidian-specific parts of the setup flow.

## What `wotw init` does for Obsidian

When you run `wotw init`, the wizard:

1. Reads your Obsidian registry file (`obsidian.json` — path varies
   per platform; see below) and lists every existing vault as a
   pick-one menu item alongside "create new vault here" and "enter a
   custom path".
2. If you pick an existing vault, the wizard detects the `.obsidian/`
   directory and asks whether to create `raw/` + `wiki/` at the
   vault root, or inside a subdirectory (default name: `wotw`).
3. If you pick "create new vault here" (or any path without an
   existing `.obsidian/`), the wizard writes sensible defaults to
   `.obsidian/{app.json, appearance.json, graph.json}` so Obsidian
   opens into a usable state immediately.
4. On success the wizard offers to launch the vault in Obsidian via
   the `obsidian://open?path=<encoded>` URI scheme. If Obsidian isn't
   installed the wizard prints a friendly fallback note and exits
   cleanly.

## Registry file location

| Platform | Path |
|----------|------|
| macOS | `~/Library/Application Support/obsidian/obsidian.json` |
| Windows | `%APPDATA%\obsidian\obsidian.json` |
| Linux / WSL | `${XDG_CONFIG_HOME:-~/.config}/obsidian/obsidian.json` |

The file is a JSON document with a `vaults` object mapping a hex ID
to `{ path, ts, open }`. wotw reads it best-effort — a missing,
unreadable, or malformed file just produces an empty vault list and
falls through to the "create new" / "enter a custom path" branches.

## Overlay vs fresh vault

**Fresh vault (no `.obsidian/`):** the wizard owns the layout. It
writes `raw/`, `wiki/`, `CLAUDE.md`, `wotw.yaml`, `.gitignore`,
`.git/`, and a minimal `.obsidian/` with a purple accent color, sane
graph color groups, and `raw/` as the default attachment folder.

**Overlay (existing `.obsidian/`):** Obsidian already owns
`.obsidian/`. The wizard never touches that directory — it only adds
`raw/`, `wiki/`, `CLAUDE.md`, `wotw.yaml`, and the `.gitignore`
append-block. You can choose to overlay at the vault root (default)
or inside a subdirectory if you'd rather keep wotw's files contained.

## Subdirectory overlay

If you pick the subdirectory overlay, the wizard writes
`<vault>/<subdir>/raw/`, `<vault>/<subdir>/wiki/`, and
`<vault>/<subdir>/CLAUDE.md`. The top-level `wotw.yaml` still lives
at the vault root with its paths pointing inside the subdir, so
`wotw start` still works from the vault root.

## `.gitignore` handling

If `.gitignore` doesn't exist at the vault root, `wotw init` writes a
full one including the standard Obsidian "device-specific" exclusions
(`workspace.json`, `workspace-mobile.json`, `cache/`, plugin
`data.json` files) plus the wotw daemon state directory `.wotw/`
and common OS noise (`.DS_Store`, `Thumbs.db`, `desktop.ini`).

If `.gitignore` already exists and does **not** mention `.wotw/`,
the wizard appends a `# wotw daemon state` block. If it already
mentions `.wotw/`, the wizard leaves it alone — no duplication.

## Launching Obsidian from the CLI

wotw uses the `obsidian://open?path=<encoded-path>` URI scheme and
dispatches it via the platform launcher:

- **macOS:** `open obsidian://open?path=…`
- **Windows:** `cmd /c start "" obsidian://open?path=…`
- **Linux / WSL:** `xdg-open obsidian://open?path=…`

On WSL, make sure you have a working `xdg-open` (usually via
`wsl-open` or the built-in `wslview`) and that the Windows Obsidian
install has registered the URI handler — then the wizard will open
the vault in the Windows Obsidian UI directly from WSL.

If the launcher command fails for any reason (not installed, URI
handler not registered, timeout), the wizard prints a friendly
fallback note and exits 0. Your wiki is still fully initialized.

## Disabling the Obsidian step

Pass `--no-open` to skip the "open in Obsidian" prompt entirely:

```bash
wotw init --no-open
```

The wizard will still detect existing Obsidian vaults from the
registry (they make good default locations) and still write
`.obsidian/` defaults for fresh vaults — it just won't launch
anything at the end.

## Troubleshooting

**"No Obsidian vaults detected" but I have vaults installed.**
Obsidian needs to have opened the vault at least once for it to
appear in `obsidian.json`. Open the vault manually in Obsidian, then
re-run `wotw init` — it should appear in the pick-list.

**The wizard picked the wrong `.config` directory on Linux.**
Set `XDG_CONFIG_HOME` to the correct directory before running
`wotw init`. The wizard re-reads it on every run.

**I want to move my vault to a new path after init.**
Move the directory. `wotw.yaml` uses paths relative to the vault
root, so everything keeps working as long as you run `wotw start`
from inside the moved vault.
