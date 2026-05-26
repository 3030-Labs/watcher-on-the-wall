# Self-hosted BYOK (Bring Your Own Key)

> If you're running `wotw` for yourself on your own machine, **you own the
> LLM key**. `wotw` doesn't ship a hosted runtime or a pooled key. This
> document explains where the key goes, how the daemon reads it, what
> happens when it's wrong, and how to rotate it.
>
> For the threat model behind these design choices, see
> [byok-threat-model.md](byok-threat-model.md). For the rationale on which
> features auto-enable under which provider, see
> [llm-provider-auto-resolution.md](llm-provider-auto-resolution.md).

## Which providers `wotw` supports

| Provider | Key env var | Cost | Fact-extraction default |
|---|---|---|---|
| Claude Code CLI (subscription) | `CLAUDE_API_KEY` (handled by `claude` binary, not by `wotw` directly) | "Free" with subscription | **On** |
| Anthropic API | `ANTHROPIC_API_KEY` | Pay per token | Off (opt-in) |
| OpenAI API | `OPENAI_API_KEY` | Pay per token | Off (opt-in) |
| Gemini API | `GOOGLE_API_KEY` | Pay per token | Off (opt-in) |
| Ollama (local) | (none) | "Free" — uses your CPU/GPU | **On** |

Multiple providers can be configured simultaneously per tenant; the
daemon dispatches based on the `llm.providers[]` list in
`wotw.config.yaml`. See [configuration.md](configuration.md) for the
schema.

## Where the key lives

### Recommended: shell environment

The simplest, safest place for an Anthropic / OpenAI / Gemini key is your
shell environment. Set it once and let `wotw start` inherit it:

```bash
# ~/.bashrc, ~/.zshrc, or your equivalent
export ANTHROPIC_API_KEY="sk-ant-..."
```

When you run `wotw start`, the daemon process inherits the env var. The
key never lands on disk in a `wotw`-controlled file.

### Acceptable: project-local `.env`

If you want per-project keys (say, separate org accounts for separate
wikis), put them in a `.env` next to `wotw.config.yaml`:

```env
# .env  (gitignored)
ANTHROPIC_API_KEY=sk-ant-...
```

`wotw` automatically picks up `.env` in the working directory when the
daemon starts. **Add `.env` to your `.gitignore`** — there is no built-in
check that prevents you from committing it.

### Discouraged: literal value in `wotw.config.yaml`

You _can_ put the key directly in `wotw.config.yaml`:

```yaml
execution:
  api_key_env: "ANTHROPIC_API_KEY"
  # Don't do this:
  # api_key_literal: "sk-ant-..."
```

— but the config file is checked into version control much more often
than `.env`, so this is a footgun. We do not advertise it as a supported
pattern. If you find yourself wanting it, ask in an issue and we'll
discuss the use case.

### How the daemon reads the key

At daemon startup, `src/ingestion/execution-mode.ts` resolves the active
provider from `llm.provider` (or `WOTW_LLM_PROVIDER` env override) and
looks up its env var:

| Provider | Env var read |
|---|---|
| `anthropic` | `process.env[execution.api_key_env]` (default `ANTHROPIC_API_KEY`) |
| `openai` | `process.env.OPENAI_API_KEY` |
| `gemini` | `process.env.GOOGLE_API_KEY` |
| `ollama` | None |
| `cli` (Claude Code) | None — delegated to the `claude` binary on `$PATH` |

The key value is held in memory by the provider object for the daemon's
lifetime, used to construct SDK clients on demand, and **never written
to disk by `wotw` itself**. Pino's redact paths in `src/utils/logger.ts`
explicitly scrub `api_key`, `apiKey`, and `Authorization` from log
output as a defense-in-depth measure.

## Failure modes

### 1. Key not set

**Symptom:** `wotw start` exits immediately with:

```
✖ Execution mode = 'api' but ANTHROPIC_API_KEY is not set in this shell.
  Set it via:  export ANTHROPIC_API_KEY="sk-ant-..."  (or in a .env file
  alongside wotw.config.yaml). See docs/self-hosted-byok.md for details.
```

**Fix:** export the key in your shell, or put it in `.env`. Source your
shell rc if you just edited it (`source ~/.zshrc`). Re-run `wotw start`.

If the daemon was already running when you set the env var, it won't
see the change — `wotw stop && wotw start` to pick it up.

### 2. Key set but invalid (401 from provider)

**Symptom:** ingestion runs fail with an HTTP 401 in the daemon log,
batches end up in the dead-letter queue, and `wotw status` reports a
growing failed-batch count. The MCP server is fine; reads from existing
wiki pages work.

**Daemon log line** (sanitized):

```
ERROR ingestion/queue: provider=anthropic batch=batch-2026-05-26T... failed: api_error 401 Unauthorized — Invalid API key provided
```

**Fix:** verify your key in a fresh shell (`curl -H "x-api-key: $ANTHROPIC_API_KEY" https://api.anthropic.com/v1/models`). If it's revoked, regenerate at your provider's console and update the env var. Restart the
daemon.

If you've rotated keys and the daemon is still using the old one, the
daemon process inherited the old env at startup. Always restart after
a rotation.

### 3. Key set but rate-limited (429 from provider)

**Symptom:** intermittent failures during heavy ingestion. Logs show:

```
WARN ingestion/queue: provider=anthropic 429 rate_limit_error — retry-after 11s
INFO ingestion/queue: requeue batch=batch-... after 11s backoff
```

**`wotw status`** will show in-flight retries and (if backoff is
exhausted) dead-letter queue entries.

**Fix:** lower `ingestion.concurrency` in `wotw.config.yaml`, or wait
for the rate-limit window to recover. The daemon implements exponential
backoff with jitter; sustained 429s usually mean your tier needs an
upgrade. See your provider's rate-limit docs.

For Anthropic specifically, the relevant tier table is at
[anthropic.com/api/rate-limits](https://www.anthropic.com/api/rate-limits).
You can also `wotw start --paused`, set a lower batch size, and resume.

### 4. Key set but missing required permissions

**Symptom:** ingestion fails with provider-specific errors like
"model not available for this key" (some OpenAI keys are scoped to a
single project), or "billing not configured" (a brand-new account with
no payment method).

**Fix:** check the provider's console for the key's scopes / billing
status. The daemon doesn't try to interpret these messages — it
surfaces the provider's error verbatim into the log and the dead-letter
queue.

### 5. Network blocked / DNS fails

**Symptom:** ingestion fails with `ENOTFOUND api.anthropic.com` or
`ECONNREFUSED` or a TLS error. Could be:

- Corporate firewall / proxy not in `HTTPS_PROXY` env.
- VPN routing weirdness.
- DNS poisoning / IPv6 vs IPv4 selection.

**Fix:** confirm `curl https://api.anthropic.com/v1/models` works in
the same shell. If it does and `wotw` doesn't, file a bug with the
exact log line — there's an environment-pickup discrepancy worth
investigating.

If you're behind a corporate proxy, set `HTTPS_PROXY` /
`HTTP_PROXY` / `NO_PROXY` in your shell before `wotw start`. The
underlying provider SDKs honour those.

## Rotation procedure

To rotate an Anthropic / OpenAI / Gemini key without losing in-flight
ingestion:

```bash
# 1. Generate the new key at your provider's console.

# 2. Verify it works:
ANTHROPIC_API_KEY="sk-ant-NEW..." curl -sS https://api.anthropic.com/v1/models \
  -H "x-api-key: sk-ant-NEW..." -H "anthropic-version: 2023-06-01" \
  | jq -r '.data[].id' | head -3
# expect: a model list

# 3. Drain the daemon (stop accepting new batches, finish in-flight):
wotw drain  # waits up to ingestion.shutdown_grace_sec; default 60s

# 4. Stop the daemon:
wotw stop

# 5. Update the env var (~/.bashrc, .env, etc):
export ANTHROPIC_API_KEY="sk-ant-NEW..."

# 6. Restart:
wotw start

# 7. Confirm the new key is active:
wotw status      # should show the daemon healthy
wotw logs -f     # tail to verify next ingestion succeeds against the new key

# 8. Revoke the OLD key in the provider console only AFTER (7) succeeds.
#    If something is wrong with the new key, you can roll back the env
#    var and skip step 8.
```

`wotw drain` is preferred over `wotw stop` for this flow because the
daemon will not start new LLM calls during drain — so the old key
won't be used after step 3, even if the rotation itself takes a few
minutes.

## Multi-tenant deployments

If you're running `wotw` for multiple users / workspaces, you have
options:

- **One daemon per tenant** (recommended): each daemon has its own
  `wotw.config.yaml`, its own `.env`, its own port. Process isolation
  is the strongest BYOK boundary. This is how `wotw-cloud` does it
  (one Fly Machine per tenant; see
  [byok-threat-model.md](byok-threat-model.md)).
- **One daemon, per-tenant tokens**: `multi_user.enabled: true` adds
  per-user bearer tokens for MCP access. The LLM key is still shared
  across tenants — useful only if all tenants belong to the same
  billing entity.

`wotw` does **not** support per-MCP-request key dispatch. The active
LLM key is daemon-scoped, not request-scoped. If you need per-request
key dispatch, you're building a multi-tenant control plane and
`wotw-cloud` (or your own equivalent) is the right tier for it.

## Verifying your key never lands somewhere it shouldn't

Quick checks:

```bash
# 1. Daemon log should never contain the key.
grep -F "$ANTHROPIC_API_KEY" ~/.wotw/daemon.log
# expected: no output

# 2. Wiki pages should never contain the key.
grep -rF "$ANTHROPIC_API_KEY" ~/.wotw/<tenant>/wiki/
# expected: no output

# 3. Cost log should never contain the key.
grep -F "$ANTHROPIC_API_KEY" ~/.wotw/<tenant>/cost.jsonl
# expected: no output

# 4. Git commits should never contain the key.
git log -p -G"sk-ant-" -- ~/.wotw/<tenant>/wiki/
# expected: no output
```

If any of these turn up the key, **that's a security bug**. Report it
via the process in [SECURITY.md](../SECURITY.md). The credential-redaction
pipeline at `src/utils/sanitize.ts` is the single source of truth for
this guarantee — bypasses are critical.

## See also

- [byok-threat-model.md](byok-threat-model.md) — the security boundaries
  this BYOK posture defends.
- [llm-provider-auto-resolution.md](llm-provider-auto-resolution.md) —
  how `wotw` picks defaults per provider, including fact-extraction
  gating.
- [configuration.md](configuration.md) — the full schema for
  `wotw.config.yaml`.
- [SECURITY.md](../SECURITY.md) — vulnerability disclosure.
