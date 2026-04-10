# Configuration

`wotw` uses [cosmiconfig](https://github.com/cosmiconfig/cosmiconfig)
to discover a config file, searching (in order):

- `package.json` (`wotw` key)
- `.wotwrc` / `.wotwrc.json` / `.wotwrc.yaml` / `.wotwrc.yml`
- `wotw.config.json` / `wotw.config.yaml` / `wotw.config.yml`

`wotw init` writes a `wotw.config.yaml` with sane defaults. You only
need to override the fields you care about — everything else inherits
from the built-in defaults.

---

## Full schema with defaults

```yaml
# Root of the wiki store. Relative paths are resolved against the
# directory containing the config file.
wiki_root: ./wiki-store

# Where to watch for raw input files.
raw_path: ./wiki-store/raw

# Execution mode — picks the runtime that will host every agent loop.
# See docs/execution-modes.md for the full breakdown.
execution:
  mode: auto                   # auto | cli | api
  cli_path: claude             # binary name or absolute path to the Claude CLI
  cli_model: claude-sonnet-4-5 # model passed to `claude --model` in CLI mode
  api_key_env: ANTHROPIC_API_KEY  # env var consulted in API mode

# Model routing — API MODE ONLY. In CLI mode every operation uses
# `execution.cli_model` regardless of the values below.
models:
  ingest: claude-haiku-4-5       # batch ingestion of raw notes
  query: claude-sonnet-4-5       # natural-language query answering
  lint: claude-sonnet-4-5        # `wotw lint` pass
  compound_eval: claude-haiku-4-5  # compounding synthesis

watcher:
  debounce_initial_ms: 5000      # first batch fires 5s after first event
  debounce_max_ms: 60000         # ...but no longer than 60s
  debounce_growth_factor: 1.5    # each new event extends the wait by 1.5×
  burst_threshold: 5             # 5 events in a burst → instant flush
  max_batch_size: 20             # cap per batch
  ignore_patterns:
    - "**/.git/**"
    - "**/node_modules/**"
    - "**/.DS_Store"
    - "**/Thumbs.db"

ingestion:
  max_turns: 50                  # hard cap on agent turns per batch
  max_budget_per_batch_usd: 1.0  # hard cap on spend per batch
  resume_session: true           # keep agent session across batches when possible
  dead_letter_file: .wotw/failed-batches.jsonl  # JSONL ledger of permanently-failed batches (empty string disables)

cost:
  max_daily_usd: 10.0            # hard daily budget (all operations combined)
  max_per_query_usd: 0.5         # per-query cap
  max_per_ingest_usd: 2.0        # per-ingest-batch cap
  track_file: ~/.wotw/cost-log.jsonl

server:
  port: 8787
  host: 127.0.0.1                # bind to localhost by default
  auth_token: null               # set to a secret to require bearer auth
  rate_limit_rpm: 60             # per-IP requests per minute

daemon:
  pid_file: ~/.wotw/daemon.pid
  lock_file: ~/.wotw/daemon.lock
  log_file: ~/.wotw/daemon.log
  log_level: info                # trace|debug|info|warn|error

compounding:
  enabled: true
  min_source_pages: 3            # skip if the wiki has fewer pages total
  confidence_threshold: 70       # only commit syntheses above this confidence

provenance:
  enabled: true
  chain_file: provenance-chain.jsonl  # resolved relative to wiki_root
  verify_on_startup: false       # set true to walk the chain on boot

multi_user:
  enabled: false                 # set true to use TokenStore
  workspaces_dir: ~/.wotw/workspaces

lint:
  schedule_enabled: false        # true → run the linter on a timer alongside the daemon
  interval_hours: 24             # how often the scheduler fires when enabled
```

---

## Feature notes

### `lint.schedule_enabled`

When `true`, the daemon runs a background `LintScheduler` subsystem
that fires the same structural sweep as `wotw lint` on the interval
you set. A clean sweep logs INFO; a sweep with issues logs WARN so
it surfaces in `wotw logs` without you having to poll. The scheduler
timer is `unref`'d, so it never keeps the daemon alive on its own.

Leave this `false` (the default) and the scheduler is a cheap no-op;
you can still run `wotw lint` manually whenever you like.

### `ingestion.dead_letter_file`

When an ingestion batch fails permanently (budget exhausted, agent
throws, wiki write errors, etc.), the dead-letter queue appends a
single JSON line to this file with the batch id, the input files, the
failure reason, the execution mode, and the error message + stack.
The count is surfaced in `wotw status` and the `get_stats` MCP tool so
you can monitor it without tailing the log.

Set to an empty string (`""`) to disable the queue — every `record()`
call then becomes a no-op. The default location
(`.wotw/failed-batches.jsonl`) is relative to the directory you
launched the daemon from; use an absolute path if you want the ledger
somewhere specific.

---

## Environment variables

| Variable | Purpose |
|----|----|
| `ANTHROPIC_API_KEY` | Your Anthropic API key. Required when `execution.mode` resolves to `api`. The env var name is configurable via `execution.api_key_env`. |
| `WOTW_DEBUG` | Set to `1` to print full stack traces on CLI errors. |
| `WOTW_CONFIG` | Path to a config file. Overrides cosmiconfig discovery. |
| `WOTW_DAEMON_CHILD` | Internal: set by the CLI when spawning the daemon. Do not set manually. |

In `cli` mode no API key is needed — the daemon spawns the `claude` binary
which uses your existing Claude Pro/Max subscription.

---

## Path resolution rules

All path-like fields are expanded before use:

- `~` → the user's home directory
- Relative paths → resolved against the config file's directory (or
  `process.cwd()` if no config file was found)
- `provenance.chain_file` is special: it's resolved **against the
  already-resolved `wiki_root`**, so a relative default like
  `provenance-chain.jsonl` lands next to the wiki.

---

## Secrets

- `ANTHROPIC_API_KEY` should live in your shell environment or a
  `.env` file — never in `wotw.config.yaml`.
- `server.auth_token` and the multi-user token store are secrets. The
  token store file has mode `0600`.
