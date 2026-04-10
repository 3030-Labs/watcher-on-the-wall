# Multi-user mode

`wotw` supports two authentication modes for its MCP server:

1. **Single-token mode** (default). One shared secret, configured at
   `server.auth_token`. All clients present the same token.
2. **Multi-user mode**. Each user has their own bearer token. Tokens
   are tracked in a JSON file on disk and managed via
   `wotw user add|list|revoke`. The authenticated user name is
   attached to every request's provenance metadata.

This document covers multi-user mode.

---

## Enabling it

```yaml
# wotw.config.yaml
multi_user:
  enabled: true
  workspaces_dir: ~/.wotw/workspaces
```

`workspaces_dir` is where the token store lives (a JSON file named
`tokens.json` inside it). Per-user workspace overlays on the wiki
itself (think: private scratchpads) are planned but not yet
implemented; today, `workspaces_dir` contains only the token store.

When `multi_user.enabled: true`, `server.auth_token` is ignored.

---

## Provisioning a user

```bash
wotw user add alice
```

Output:

```
Issued token for alice.

Token (save this — it will not be shown again):
  wotw_a1b2c3d4e5f6…

Configure clients with `Authorization: Bearer <token>`.
```

**You only see the token once.** `wotw` never persists the token in
recoverable form — the JSON file does store the full token (so the
server can authenticate), but the `wotw user add` command prints it
only at creation time.

If you re-run `wotw user add alice`, any previous token for alice is
revoked and a new one is issued. This enforces a one-active-token-per-user
policy.

---

## Listing users

```bash
wotw user list
```

```
Active users (2):

  ● alice                 2026-04-01T12:00:00.000Z
  ● bob                   2026-04-01T12:05:00.000Z
```

`--json` emits a machine-readable form.

---

## Revoking a user

```bash
wotw user revoke alice
```

Removes every token for alice. Any subsequent requests from alice's
old token return HTTP `401`.

The daemon does **not** need to be restarted — the token store is
re-read on every authentication check… wait, no. Today the server
loads the token store once at startup. **You must restart the daemon
after revoking a user for the revocation to take effect across a
running server.** A `SIGHUP`-based hot reload is planned.

> In tests, the in-process token store is mutated and picked up
> immediately because the test holds the same object reference.

---

## Client configuration

Every MCP client gets a different bearer token. For Claude Desktop:

```json
{
  "mcpServers": {
    "watcher-on-the-wall": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/cli", "http", "http://127.0.0.1:8787/mcp"],
      "env": {
        "MCP_HTTP_HEADERS": "Authorization: Bearer wotw_a1b2c3d4e5f6…"
      }
    }
  }
}
```

The exact config shape depends on your client — just arrange for
`Authorization: Bearer <token>` on every outgoing request.

---

## Token format

Tokens are exactly `wotw_` + 64 hex characters (32 bytes of CSPRNG
entropy). The `wotw_` prefix exists so you can grep for leaked tokens
in logs, shell history, and git diffs.

---

## Storage

The token store is a JSON file with mode `0600`:

```json
{
  "version": 1,
  "tokens": {
    "wotw_a1b2…": { "user": "alice", "created": "2026-04-01T12:00:00.000Z" },
    "wotw_c3d4…": { "user": "bob",   "created": "2026-04-01T12:05:00.000Z" }
  }
}
```

The file is written atomically (temp file + rename) on every mutation.
