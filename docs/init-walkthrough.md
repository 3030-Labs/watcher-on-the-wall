# `wotw init` — interactive walkthrough

> Every prompt the setup wizard asks, every default, every exit state.
> Read this before your first run so you know what the daemon is about
> to do and where it's about to put things.

The wizard is implemented at [`src/cli/commands/init.ts`](../src/cli/commands/init.ts);
this document mirrors its actual decision tree.

## Invocation modes

```bash
wotw init                       # interactive (recommended)
wotw init --path /vault/dir     # interactive, but skip the vault-pick prompt
wotw init --yes                 # non-interactive; uses defaults
wotw init --force               # bypass idempotency guard; re-scaffold
wotw init --no-open             # skip the "open in Obsidian?" prompt
```

The wizard is **fully idempotent** — running it a second time on an
already-initialized directory exits cleanly with no changes (see
"Idempotent re-run" below). `--force` is the override.

`--yes` (non-interactive) is what CI and install-evidence workflows use.
It picks all defaults and skips every prompt.

## Step 1: vault location

**Prompt:**

> Where should the wiki live?

**Options** (auto-populated from the system Obsidian registry):

```
  / Vault: ~/Obsidian/research   (detected from Obsidian registry)
  / Vault: ~/Obsidian/journal    (detected from Obsidian registry)
  / Vault: ~/Obsidian/work       (detected from Obsidian registry)
  / Create new vault here        ~/current/working/dir
  / Enter a custom path
```

If **no vaults are registered with Obsidian** (e.g. Obsidian isn't
installed, or you've never opened a vault), this step skips the select
prompt and goes straight to:

> Vault path
> placeholder: `~/current/working/dir`

If you pass `--path /foo`, this step is **skipped entirely**.

**Defaults**: highlight the first detected vault. If none, default to
the current working directory.

**Validation**:
- Empty path rejected.
- Relative paths resolved against `process.cwd()`.
- Paths containing `..` segments must resolve under a real existing
  parent. Pure traversal attempts fail.

## Step 1.5: idempotency check (silent in non-init paths)

After the path resolves, the wizard checks whether this path is already
initialized:

```
target/
  .wotw/      ← exists ⇒ initialized
  raw/        ← exists ⇒ initialized
  wiki/       ← exists ⇒ initialized
```

If **all three exist**, the wizard exits cleanly:

```
│ Idempotent re-run ─
│   Already initialized at /Users/justin/Obsidian/research — structure
│   verified, nothing to do.
│
└  Nothing to do.
```

Exit code: `0`. `--force` overrides this and re-scaffolds.

## Step 2: overlay vs fresh vault

If the target path contains a `.obsidian/` directory (it's an existing
Obsidian vault), the wizard asks:

> Found an existing Obsidian vault. Create raw/ and wiki/ inside it?

**Default**: Yes (overlay into the vault root).

**If Yes**: the wizard creates `raw/` and `wiki/` directly at the vault
root. Obsidian will pick them up the next time you open the vault.

**If No**: the wizard asks:

> Subdirectory name (will be created inside the vault)
> initialValue: `wotw`

You can name it anything that's a single directory name (no slashes).
The wizard creates `<vault>/<subdir>/raw/` and `<vault>/<subdir>/wiki/`.

If the target path does **not** contain `.obsidian/`:

```
│ Fresh vault ─
│   No existing .obsidian/ detected — /target/path will be set up as
│   a fresh vault with sensible Obsidian defaults.
```

The wizard will create `.obsidian/` with default settings during scaffolding.

## Step 3: runtime detection (informational)

The wizard auto-detects which LLM runtime is available:

```
│ Runtime ─
│   CLI mode (claude binary found at /usr/local/bin/claude)
```

Possible runtime states:

| Detected | Reported |
|---|---|
| `claude` CLI on `$PATH` | `CLI mode (claude binary found at <path>)` |
| `ANTHROPIC_API_KEY` set, no CLI | `API mode (provider=anthropic, key from ANTHROPIC_API_KEY)` |
| Both set | `CLI mode preferred; API mode available as fallback` |
| Neither | `none — install Claude Code or set ANTHROPIC_API_KEY` |

**No prompt**: the wizard does not ask you to choose. The active
runtime is determined at `wotw start` time from `wotw.config.yaml`'s
`execution.mode` and `llm.provider` — the wizard scaffolds a config
that picks the detected runtime as the default and you can edit later.

If no runtime is detected, the wizard prints a warning **but proceeds**.
The wiki structure is still created; you'll get an error at `wotw start`
time telling you to set up a runtime. See
[self-hosted-byok.md](self-hosted-byok.md).

## Step 4: scaffold (spinner)

```
◇  Scaffolding wiki structure
│  ✔ Wiki scaffolded
```

Creates (idempotent — existing files are not overwritten unless `--force`):

```
<target>/
  .wotw/                       # daemon state directory
    config.yaml                # editable config (see configuration.md)
  raw/                         # drop source files here
  wiki/                        # generated wiki pages land here
    index.md                   # starter index page
    log.md                     # daemon activity log (templated)
    CLAUDE.md                  # agent context primer
  .obsidian/                   # only if fresh vault
    app.json
    appearance.json
    workspace.json
```

If scaffold fails (EACCES on the target, disk full, etc.), the spinner
stops with `Scaffold failed` and the error propagates. The wizard does
not attempt cleanup — you'll need to `rm -rf` and retry.

## Step 5: open in Obsidian (interactive only, optional)

```
◇  Open vault in Obsidian now?
│  / Yes (default)
│  / No
```

**If Yes**: the wizard tries to launch Obsidian against the vault path.

Platform-specific launcher:
- **macOS**: `open obsidian://open?vault=<path>`
- **Linux**: tries `xdg-open obsidian://open?vault=<path>` then
  `obsidian` on `$PATH`
- **Windows**: `start obsidian://open?vault=<path>`

If the launch fails:

```
│ Launch skipped ─
│   Couldn't open Obsidian automatically. Open the folder as a vault
│   manually.
```

Or, if Obsidian isn't installed at all:

```
│ Obsidian not installed ─
│   Obsidian doesn't appear to be installed. Your wiki is plain
│   markdown and works without it, but for the best experience install
│   Obsidian from https://obsidian.md and open this folder as a vault.
```

This is informational — the wizard does **not** fail if Obsidian is
missing. Your wiki works fine as plain markdown.

`--no-open` skips this step entirely.

## Step 6: next steps + success

```
│ Next steps ─
│   1. Drop files in <target>/raw/
│   2. wotw start
│   3. Inspect <target>/wiki/ as files are written
│
└  Done! Your wiki is ready.
```

Exit code: `0`.

## Platform-specific notes

### macOS arm64 + amd64

- The Obsidian registry is read from `~/Library/Application Support/obsidian/obsidian.json`.
- If you have iCloud Drive-backed vaults, the wizard sees them (the
  path is the local sync mount, not the cloud URL).
- The "open in Obsidian" step uses macOS's `open` URL handler; it
  requires Obsidian.app to be installed in `/Applications/` or
  `~/Applications/`.

### Linux amd64

- The Obsidian registry is at `~/.config/obsidian/obsidian.json`.
- Snap and Flatpak Obsidian installs sometimes register differently;
  if the wizard doesn't see your vaults, pick "Enter a custom path"
  and paste the path manually.
- "Open in Obsidian" requires `xdg-open` or `obsidian` on `$PATH`.
  On headless servers, pass `--no-open`.

### Windows amd64 (PowerShell + cmd)

- The Obsidian registry is at `%APPDATA%\obsidian\obsidian.json`.
- Vault paths use Windows-style separators (`C:\Users\Name\...`); the
  wizard handles them correctly.
- PowerShell vs cmd: both work. The wizard uses Node's `process.stdin`
  and `process.stdout` directly, so terminal capabilities are inherited
  from the parent shell.
- "Open in Obsidian" uses `start` and requires Obsidian to be installed
  via the official Windows installer (the `obsidian://` URL handler
  is registered then).

### WSL2 (Linux side)

- WSL2 sees Linux's `~/.config/obsidian/obsidian.json` (probably empty).
- Vaults that live on the Windows side (`/mnt/c/Users/.../Obsidian/...`)
  work as filesystem paths, but Obsidian's URL handler can't reach
  across the WSL boundary — pass `--no-open` and launch Obsidian
  from Windows manually.

## Non-interactive mode (`--yes`)

In non-interactive mode the wizard uses these defaults at every prompt:

| Step | Default |
|---|---|
| Vault path | `--path` value if given, else `process.cwd()` |
| Overlay vs subdir | overlay (root of the vault) if `.obsidian/` exists, else create vault in place |
| Open in Obsidian | skipped |

All other behavior is identical. Use `--yes` in CI, containers,
provisioning scripts, and the install-evidence workflows under
`.github/workflows/install-evidence.yml`.

## Exit states

| Code | Meaning |
|---|---|
| `0` | Success — wiki scaffolded (or idempotent re-run on an already-initialized vault). |
| `1` | Generic failure (scaffold I/O error, etc). Check stderr for the underlying error. |
| `130` | `SIGINT` / Ctrl-C interrupt during a prompt. No partial state written. |

If the wizard exits non-zero after creating partial state, `rm -rf
<target>/.wotw <target>/raw <target>/wiki` and retry. The wizard does
not implement transactional rollback — exits before scaffold complete
are safe (nothing written); exits during scaffold may leave the
above three directories partially populated.

## See also

- [configuration.md](configuration.md) — the full schema for the
  scaffolded `wotw.config.yaml`.
- [obsidian-setup.md](obsidian-setup.md) — Obsidian-side configuration
  for the freshly-scaffolded vault.
- [self-hosted-byok.md](self-hosted-byok.md) — picking and configuring
  your LLM provider key after `wotw init`.
- [cli-reference.md](cli-reference.md) — every `wotw <command>` and
  flag.
