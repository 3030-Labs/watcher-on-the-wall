# Telemetry

> **TL;DR.** `wotw` ships with telemetry **disabled by default and ships no
> 3030 Labs Sentry DSN.** There is no per-install telemetry, no first-run
> "phone home", and no anonymous-usage statistics. The only telemetry
> surface is an *opt-in*, *bring-your-own-DSN* Sentry breadcrumb on
> `wotw init` failures, controlled by the `WOTW_TELEMETRY_DSN`
> environment variable. If you don't set it, nothing leaves your machine.

## What `wotw` sends, when it's enabled

When (and only when) you set `WOTW_TELEMETRY_DSN`, the daemon will send
**one event** for each `wotw init` failure, containing **only these
fields**:

| Field | Example | Source |
|---|---|---|
| `category` | `init/native-binding-load-failure` | Stable enum, one of 10 values (see below). |
| `daemonVersion` | `0.8.4` | `package.json`. |
| `platform` | `darwin` | `os.platform()`. |
| `arch` | `arm64` | `os.arch()`. |
| `nodeVersion` | `v22.16.0` | `process.version`. |
| `stage` (optional) | `scaffold-mkdir` | Stable enum string when emitted by an internal pipeline step; otherwise omitted. |

That's it. The validator at `src/telemetry/sink.ts::validateEvent`
rejects any field outside that allow-list — there is no codepath where
a vault path, an API key, a wiki page title, a file content, or a
user-controlled string can land in a telemetry payload.

## What `wotw` does NOT send, ever

Even with telemetry enabled, the following are **forbidden by code**:

- Your Anthropic / OpenAI / Gemini / Sentry API keys
- Your vault path, wiki page paths, or any filesystem path you control
- Wiki page contents, raw source contents, or any document body
- Your bearer tokens (`wotw_<64hex>`)
- Your tenant ID or workspace ID
- Your IP address (Sentry SDK strips it via `beforeSend`)
- Your username, hostname, or any OS-user-identifying metadata
- LLM responses or query strings
- Provenance chain bytes
- Cost-log entries

If you find a code path that bypasses these restrictions, that's a
**security bug** — report it via [SECURITY.md](../SECURITY.md).

## Categories (the full enum)

The categorizer at `src/telemetry/categorize.ts` maps every ActionableError
to one of these stable strings. **The enum is the entire user-controlled
surface**:

| Category | When it fires |
|---|---|
| `init/missing-vault-path` | No vault path was provided and no Obsidian vault was detected. |
| `init/target-not-empty` | `wotw init` against a non-empty, non-Obsidian, non-wotw target. |
| `init/config-parse-error` | `wotw.config.yaml` (or equivalent) failed to parse. |
| `init/native-binding-load-failure` | `better-sqlite3` (or another native dep) couldn't load on this platform. |
| `init/wiki-dir-permission-denied` | `EACCES` / `EPERM` creating the wiki directory. |
| `init/port-in-use` | The MCP server port is already bound. |
| `init/daemon-already-running` | A live daemon already holds the lock file. |
| `init/runtime-not-detected` | Neither `claude` CLI nor any API key was found (also covers invalid-key + rate-limited variants seen at init). |
| `init/scaffold-failed` | Generic catch-all for scaffold I/O failures, including locked files. |
| `init/unknown-failure` | Anything else. The receiver should treat this as "more investigation needed". |

## How to enable

1. **Create your own Sentry project.** Sign up at
   [sentry.io](https://sentry.io) (or use a self-hosted Sentry). Create
   a project of type "Node.js". Copy the DSN — it looks like
   `https://<hash>@<orgid>.ingest.sentry.io/<projectid>`.
2. **Install the SDK** (it is NOT a default dependency):
   ```bash
   npm install @sentry/node
   # or, in your wotw install dir:
   pnpm add @sentry/node
   ```
   If the SDK isn't installed when telemetry fires, the sink logs a
   warning and falls back to no-op — no crash.
3. **Export the DSN** before `wotw start` / `wotw init`:
   ```bash
   export WOTW_TELEMETRY_DSN="https://<your-dsn>"
   ```
4. **Verify.** Trigger a known-failing init and check your Sentry
   project for the event:
   ```bash
   # On a path your user can't write to, e.g.
   mkdir -p /tmp/readonly && chmod 555 /tmp/readonly
   wotw init --path /tmp/readonly --yes --no-open
   # → init fails with WIKI_DIR_PERMISSION_DENIED
   # → check your Sentry project; you should see one event with
   #   category=init/wiki-dir-permission-denied
   ```

## How to disable (the default state)

```bash
unset WOTW_TELEMETRY_DSN
# or remove the line from your shell rc
```

That's it. No config knob. The env var IS the toggle.

## Why opt-in BYO-DSN, not "anonymous usage stats"

Three reasons:

1. **Trust posture.** A new self-hosted user evaluating `wotw` should
   not have to trust 3030 Labs with anything. If they want crash
   visibility, they should own the data; we should never see it.
2. **No "anonymous-but-not-really" pretense.** Many "anonymous" telemetry
   pipelines correlate via install IDs, IP addresses, or temporal
   patterns. Ours can't, because it doesn't exist on our infra.
3. **Privacy posture matches BYOK.** `wotw` is local-first + BYOK for
   LLM keys (see [self-hosted-byok.md](self-hosted-byok.md)). Telemetry
   uses the same posture: the operator chooses where their data goes.

This is also why we will not ship a "wotw stats opt-in" config flag that
sends to a 3030 Labs endpoint. The shape we've chosen — BYO DSN, opt-in
via env var, categorical payloads — is the entire deal.

## Verifying the privacy claim yourself

```bash
# 1. The src tree contains no Sentry DSN literal:
grep -rE "ingest\.sentry\.io|sentry\.io/[0-9]+" src/
# expected: no output

# 2. The default sink is NoopSink:
node -e 'console.log(require("./dist/telemetry/index.js").getTelemetrySink({}))'
# expected: NoopSink {}

# 3. The validator rejects PII-shaped fields:
node -e '
  const { validateEvent } = require("./dist/telemetry/index.js");
  console.log(validateEvent({
    category: "init/missing-vault-path",
    daemonVersion: "0.8.4",
    platform: "linux", arch: "x64", nodeVersion: "v22.16.0",
    apiKey: "sk-ant-LEAKED"
  }));
'
# expected: "disallowed field on telemetry event: apiKey"
```

The test suite at `test/unit/telemetry.test.ts` exercises every
invariant above and will fail CI if any regress.

## Sentry SDK lifecycle notes (advanced)

The Sentry SDK is **dynamically imported on first telemetry send**.
This means:

- The hot path of a telemetry-disabled `wotw` doesn't pay for the SDK
  load (cold start ~50ms saved).
- The dynamic import is wrapped in try/catch; if `@sentry/node` is
  not installed, the sink logs a warning and falls back to no-op.
- The Sentry SDK is initialized with `defaultIntegrations: false`,
  `tracesSampleRate: 0`, and a `beforeSend` hook that strips
  `user`, `request`, and `contexts` — so even if the SDK's
  auto-instrumentation tries to fill those in, they don't leave the
  process.
- Telemetry sends are flushed with a 2-second timeout. The daemon
  does not block more than 2 seconds on telemetry, ever.

## Rotation / disable in case of compromise

If you suspect your Sentry DSN has leaked (e.g. it landed in a public
log somewhere):

1. Revoke the DSN in your Sentry project's settings.
2. Generate a new one.
3. Update your `WOTW_TELEMETRY_DSN` env var.
4. Restart the daemon.

`wotw` does not cache the DSN anywhere on disk; the env var is the
only place it lives in this process tree.

## Frequently asked

**Q: Will `wotw` ever add usage telemetry beyond init failures?**
A: Not without prominent communication and a separate opt-in. The
init-failure scope is intentionally narrow because that's where new
users get stuck and the most useful for operators of self-hosted
installations to see. Runtime telemetry (queries, ingestion volume,
costs) would be a separate, explicit decision.

**Q: Can I use a self-hosted Sentry?**
A: Yes — the DSN format is the same, just pointed at your own Sentry
relay. The SDK doesn't talk to sentry.io specifically; it talks to
whatever the DSN's host portion is.

**Q: What about `wotw-cloud` (the managed-hosting product)?**
A: `wotw-cloud` is a separate product with its own observability
stack (see [byok-threat-model.md](byok-threat-model.md)). It does
NOT use the BYO-DSN telemetry described here — the cloud control
plane has its own SRE-facing logs at the operator boundary, and
those are scoped + audited separately.

**Q: I want to disable telemetry forever, even if someone sets the
env var by accident — can I?**
A: There's no compile-time-disable today. If the env var is set, the
sink activates. If you want belt-and-braces, you can put a guard in
your shell rc or systemd unit file that explicitly unsets
`WOTW_TELEMETRY_DSN` before running `wotw`.

## See also

- [SECURITY.md](../SECURITY.md) — disclosure process if you find a
  telemetry-related bug.
- [byok-threat-model.md](byok-threat-model.md) — the broader BYOK
  privacy posture this telemetry design fits into.
- `src/telemetry/sink.ts` — the implementation. ~200 lines, end-to-end.
- `src/telemetry/types.ts` — the wire shape.
- `test/unit/telemetry.test.ts` — every privacy invariant under test.
