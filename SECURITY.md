# Security Policy

## Supported versions

`wotw` is pre-1.0. Only the latest minor version receives security
fixes.

| Version | Supported |
|----|----|
| 0.1.x | ✅ |
| < 0.1 | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue.**

Email `security@3030labs.io` with:

- A clear description of the vulnerability
- Reproduction steps or a proof of concept
- The commit SHA (or version tag) you tested against
- Your disclosure timeline preferences

We aim to acknowledge reports within 72 hours and to ship a fix (or
have a fix in review) within 14 days for high-severity issues. You'll
be credited in the release notes unless you ask otherwise.

## In scope

The following are considered in-scope for `wotw`:

- **Provenance chain integrity.** Any path that would let a malicious
  actor tamper with past records without breaking the chain hash is a
  critical bug.
- **Wiki path traversal.** Every MCP tool and every ingestion write
  must refuse paths that escape `wiki_root`. The canonical check is
  in `src/server/tools.ts::resolveWikiPath` — bypasses are critical.
- **Authentication bypass.** Any way to reach an authenticated MCP
  endpoint without a valid bearer token.
- **Cost-budget bypass.** Any way to drive the daemon to spend beyond
  `cost.max_daily_usd`, `cost.max_per_ingest_usd`, or
  `cost.max_per_query_usd`.
- **Secret leakage.** API keys, bearer tokens, or user-provided paths
  appearing in log output are a bug. The sanitizer at
  `src/utils/sanitize.ts` is the only place these should be scrubbed;
  if you find log output that bypasses it, please report it.
- **Race conditions in durable writes.** The wiki store and the
  multi-user token store use temp-file + rename (`atomicWrite`); the
  cost log, provenance chain, and dead-letter queue are append-only
  JSONL files written with `appendFile` (POSIX `O_APPEND`) under a
  single-writer mutex. Any window where a crash could leave corrupt
  state — torn line, half-renamed temp, missed `fsync` — is in scope.
- **Multi-user isolation.** In multi-user mode, one tenant reading or
  writing another tenant's wiki is critical.

## Out of scope

- **DoS via huge input files.** Dropping a 1 TB file into `raw/` will
  use a lot of disk. That's expected behavior. We size-guard large
  files at the ingestion boundary but we don't try to stop an operator
  from filling their own disk.
- **Compromise of the underlying Anthropic/Claude service.** If Claude
  gets prompted into writing a malicious page, that's a prompt
  engineering concern, not a `wotw` security bug. (We do welcome PRs
  that harden the ingestion prompts against injection.)
- **Misconfiguration.** If you leave `server.auth_token` unset and
  expose the daemon to the internet on a non-loopback bind, you will
  get warnings at startup and eventually a hard refusal to start (see
  the no-auth safety rail in `src/server/index.ts`). That is not a
  vulnerability — it's operator error.
- **Issues in bundled dependencies** with no exploitable path in
  `wotw`. Please report those directly upstream.

## Deployment hardening checklist

If you're running `wotw` in anything that isn't a personal dev
machine, do all of these:

1. **Set `server.auth_token`** or enable `multi_user.enabled` with
   per-user tokens (`wotw user add`). The daemon refuses to start on
   a non-loopback bind without one of these configured.
2. **Bind to loopback** unless you're fronting it with a reverse proxy
   that terminates TLS and does auth. The default is `127.0.0.1`.
3. **Set `provenance.verify_on_startup: true`** so a corrupt chain
   halts the daemon instead of letting it continue writing on top of
   bad state.
4. **Configure `cost.max_daily_usd`** to a value you're genuinely
   willing to lose in a bad day. The default of `10.0` is not "free."
5. **Enable the dead-letter queue** (`ingestion.dead_letter_file`) and
   monitor `wotw status` — a growing count of failed batches is
   usually the first sign that something upstream is wrong.
6. **Don't commit `wotw.config.yaml` with secrets.** Keep
   `ANTHROPIC_API_KEY` and `server.auth_token` in your shell
   environment or a `.env` file that's gitignored.
7. **Back up `provenance-chain.jsonl` and the wiki git repo.** The
   chain is your compliance artifact; losing it means losing your
   audit trail.
8. **Rotate bearer tokens on personnel changes.** `wotw user revoke
   <name>` is the supported path. In single-token mode, rewrite
   `server.auth_token` and restart.

## Cryptographic details

- **Hashing.** SHA-256 over canonical JSON (recursively sorted keys,
  no whitespace). Implementation: `src/provenance/hash.ts`.
- **Chain.** Forward-folding: `chain_hash = sha256(previous_chain_hash
  || id)`. Genesis is `"0".repeat(64)`.
- **Signature scheme.** Currently none — the chain is tamper-evident,
  not tamper-proof. External signing (Sigstore / PGP / minisign) is on
  the roadmap.
- **Token storage.** Multi-user tokens are stored verbatim in
  `workspaces_dir/tokens.json` (mode `0600`, owner-only read/write).
  Tokens are 256-bit (`wotw_` + 64 hex chars) generated by
  `crypto.randomBytes`, so the on-disk file is the only credential
  material and must be treated as secret. Backup tooling, container
  image layers, and log shipping must all exclude it. A leaked
  `tokens.json` requires `wotw user revoke` for every affected user.
