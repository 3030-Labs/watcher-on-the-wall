# Execution modes

`watcher-on-the-wall` can host every agent loop in one of two runtimes.
The choice is made once at daemon startup, logged prominently, and
applied uniformly to ingestion, query, and compounding.

| Mode | Runtime | Cost model | Required setup |
|----|----|----|----|
| `cli` | Spawns the local `claude` binary as a subprocess | $0 — covered by your Claude Pro/Max subscription | `claude` binary on `PATH` |
| `api` | Uses the `@anthropic-ai/claude-agent-sdk` directly | Pay-per-token (model-router picks Haiku for ingest, Sonnet for query) | `ANTHROPIC_API_KEY` env var set |
| `auto` | Prefers `cli` if the binary is on `PATH`; falls back to `api` if a key is set; refuses to start otherwise | Inherits the resolved mode | At least one of the above |

The default is `auto`, which is the right choice for most users.

---

## How auto-detection works

At startup the daemon runs (in this order):

1. `which claude` (or `where claude` on Windows). If a path is returned,
   resolve to **CLI mode** with that path.
2. Check `process.env[execution.api_key_env]`. If non-empty, resolve to
   **API mode**.
3. Otherwise refuse to start with `NO_RUNTIME_AVAILABLE`. Install the
   Claude CLI from <https://docs.claude.com/claude-code> *or* set an API
   key, then re-run.

The resolved mode is logged at INFO with a one-line description, e.g.:

```
{"level":"info","msg":"CLI mode (auto-detected): using claude binary at /home/me/.local/bin/claude, model claude-sonnet-4-5, zero marginal cost (subscription-covered)"}
```

You can force a mode by setting `execution.mode: cli` or `execution.mode: api`
in your `wotw.config.yaml`. Forcing `cli` when the binary is missing — or
forcing `api` when the env var is unset — is a fatal error: the daemon
will refuse to start with `CLI_BINARY_NOT_FOUND` or `API_KEY_NOT_SET`
respectively.

---

## What's different in each mode

### CLI mode

- Every batch / query / synthesis spawns `claude --print
  --dangerously-skip-permissions --model <cli_model>` as a subprocess.
- The user prompt is piped on stdin to avoid `ARG_MAX` limits.
- The daemon never opens a network connection to the Anthropic API
  itself.
- Model routing is **disabled**. Every operation uses
  `execution.cli_model`. Set this to `claude-sonnet-4-5` (the default)
  for the best ingestion/query/synthesis quality.
- The daily / per-batch / per-query budget caps under `cost:` are still
  honored as logical safety nets, but they will never trip because every
  spawn logs `cost_usd = 0`.
- The watcher's debounce window is **widened by 1.5×** to coalesce more
  files per spawn, which reduces process churn without making
  interactive editing feel laggy.
- Written files are detected by snapshotting the wiki tree (path → size
  + mtime) before and after each spawn and diffing the result. This is
  format-agnostic and doesn't depend on parsing CLI output.

### API mode

- Every operation calls `query()` from the Claude Agent SDK.
- Model routing is **enabled**: ingestion uses Haiku, query/compounding
  use Sonnet. Override the picks under `models:`.
- Per-call cost is read from the SDK's `total_cost_usd` field and logged
  to `cost.track_file`.
- Pre-flight budget checks block any operation that would push the
  daily/per-call cap into the red.
- Tool whitelists are enforced via the SDK's `allowedTools` field
  (`Read/Write/Edit/Glob/Grep/TodoWrite` for ingestion;
  `Read/Glob/Grep` for query; `Read/Write/Glob/Grep` for compounding).

---

## Recommended setups

| You are... | Recommended `execution.mode` |
|----|----|
| A Pro/Max subscriber experimenting locally | `auto` (will pick `cli`) |
| Running in CI / a container without an interactive login | `api` |
| Building a multi-user instance with billing per workspace | `api` (the cost log is the source of truth) |
| Migrating from a key-based setup but want to test CLI mode | Install the `claude` binary, leave `mode: auto`. The daemon will switch automatically and log `cost=0` for every batch. |

---

## Troubleshooting

**`NO_RUNTIME_AVAILABLE` at startup.**
Neither the CLI binary nor the API key was found. Run
`which claude` to confirm the binary is on PATH, or
`echo $ANTHROPIC_API_KEY` to confirm the env var is set in the shell
that started the daemon.

**`CLI_BINARY_NOT_FOUND` despite `claude` working in your shell.**
The daemon is started by `wotw daemon-start` from the directory you
invoked it in. If you use a non-standard shell (fish, nushell) that
defines `claude` as an alias rather than a binary, the daemon's
`spawnSync('which', ['claude'])` won't see it. Install the actual binary
under `~/.local/bin` or set `execution.cli_path` to the absolute path.

**The daemon resolves to API mode even though the CLI is installed.**
Run the same `which claude` invocation from a fresh shell with no
profile loaded — the binary may be defined only by your interactive
shell config. Move it onto a directory listed in `/etc/environment` or
the systemd unit's `Environment=PATH=...`.

**Cost log shows zero for every operation.**
You're in CLI mode. That's expected — the subscription covers it.
Check the daemon's startup log for the prominent `CLI mode` line.

**Budget warnings in CLI mode.**
The cost-tracker still records every operation; in CLI mode the values
are 0, so the daily budget should never trip. If you see a budget
warning anyway, your daemon is probably in `api` mode — check the
resolved mode in the startup logs.
