# Security Policy

## Supported versions

`wotw` is pre-1.0. Only the latest minor version receives security
fixes. We do not backport to older minors; if a CVE lands, expect a
patch release on the current minor and an upgrade prompt.

| Version | Supported |
|----|----|
| 0.8.x  | ✅ (current) |
| < 0.8  | ❌ |

## Reporting a vulnerability

**Do not open a public GitHub issue.** Public-issue disclosure puts
existing users at risk before they can patch.

Email `security@3030labs.io` with:

- A clear description of the vulnerability and the threat it enables
- Reproduction steps or a proof of concept (a minimal `wotw.config.yaml`
  + the exact command sequence is usually enough)
- The commit SHA (`git rev-parse HEAD`) or version tag (`wotw --version`)
  you tested against
- The platform (OS + arch + Node version)
- Your disclosure timeline preferences (default: coordinated 30 days)
- Whether you'd like attribution in the release notes (default: yes,
  with a name + optional link of your choosing)

You may PGP-encrypt the report. Our key is published at
[wotw.dev/keys/security.asc](https://wotw.dev/keys/security.asc) (or in
`scripts/security-pgp-key.asc` if pinned to a commit).

## Response SLA

We commit to the following timeline for any report received at
`security@3030labs.io`:

| Phase | Target |
|---|---|
| Initial acknowledgment ("we received it, here is the tracking ID") | **5 business days** |
| Triage decision (in scope / out of scope, severity assigned) | **10 business days** |
| Fix shipped OR coordinated public disclosure | **30 calendar days** for high/critical; **90 days** for low/moderate |
| Credit + post-mortem in release notes | At publish of the fix release |

If we miss any of these targets, the reporter is welcome to publish
their findings. We will not pursue legal action against good-faith
research that follows this policy (see safe harbor below).

## Safe harbor for security researchers

3030 Labs LLC will NOT pursue legal action against security researchers
who, in good faith, report vulnerabilities to `security@3030labs.io`
under the following conditions:

1. **Scope discipline.** Testing is limited to `wotw` daemon code,
   official `@driftvane/wotw` npm artifacts, the `DriftVane/wotw-verify`
   binary, and infrastructure you control (your own laptop, your own
   VMs). Testing against **other people's hosted wotw deployments,
   3030 Labs' production infrastructure, or `wotw-cloud` tenants you
   are not authorized for** is out of scope and not covered.
2. **No data exfiltration beyond proof-of-concept.** If your PoC needs
   to demonstrate that data is reachable, fetch one record and stop.
   Do not exfiltrate, retain, or redistribute another user's wiki
   contents, provenance records, tokens, or LLM keys.
3. **No denial-of-service.** Rate-limit bypass demonstrations should
   stop at the smallest input that proves the bypass. Don't drive
   anyone's machine into a hot loop.
4. **Coordinated disclosure timeline.** Hold publication for the SLA
   window above (or until we ship a fix, whichever is sooner) unless
   we miss a SLA target. We will tell you up front if a fix needs more
   than 30 days and explain why.
5. **No social engineering.** Reports targeting 3030 Labs personnel,
   contractors, or users via phishing / pretexting are out of scope.
6. **Compliance with applicable law.** Safe harbor is contingent on
   the research being legal in your jurisdiction. We can't waive the
   CFAA on a foreign researcher's behalf, but we can confirm that
   testing you do against your own machine, on your own data, with
   no production-infra interaction, is something we authorize.

If you're uncertain whether a test plan falls inside safe harbor, ask
us first at `security@3030labs.io` and we'll tell you in writing.

## Bug bounty

We do not currently run a paid bounty. We will credit researchers in
release notes and at `wotw.dev/security/researchers` (once that page
exists). If you'd like a written reference letter for a portfolio,
we'll provide one for any in-scope finding rated moderate or higher.

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
