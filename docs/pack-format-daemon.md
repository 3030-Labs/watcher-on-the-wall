# Compliance Pack — daemon-side wire format

> **Scope:** this document describes the **bytes** a Compliance Pack
> contains, what guarantees the daemon makes when writing them, and how
> the customer-side [`wotw-verify`](https://github.com/3030-Labs/wotw-verify)
> Go binary parses them. **Daemon-side wire format only.**
>
> **Out of scope:** marketplace semantics — Pack as a tradeable artifact,
> Pulse / Brief / attribution / royalty / cross-tenant share / discovery —
> are tracked separately in `wotw-artifact-layer-prd.md` and the
> marketplace PRD (pending). Pack-as-a-wire-format is stable and frozen
> at v1; pack-as-a-marketplace-object is not.
>
> See **"Pack marketplace coming"** placeholder in [README.md](../README.md)
> for the higher-tier story.

## What a Pack is

A Compliance Pack is a self-contained, signature-verifiable export of a
tenant's provenance chain. It can be:

- Mailed to an auditor.
- Stored in cold archive for compliance retention.
- Replayed years later against the same `wotw-verify` binary to confirm
  no record was added, removed, or modified.
- Used as evidence in an audit dispute.

Two formats accepted: a **directory tree** on disk, or a **`.zip`
archive**. The verifier sniffs which it has and parses accordingly.
Both forms carry identical bytes for the inner files.

## Pack layout

```
<pack-root>/
  manifest.json           # required — pack metadata + version gate
  chain.jsonl             # required — one ProvenanceRecord per line
  keys.json               # required iff any chain record carries `hmac`
  content/                # optional — future content-hash recompute
```

### manifest.json

```json
{
  "version": 1,
  "tenant_id": "550e8400-e29b-41d4-a716-446655440000",
  "summary": "Q1 2026 provenance archive",
  "created_at": "2026-05-26T08:00:00Z"
}
```

- `version` MUST be exactly `1`. The verifier refuses any
  `version != 1`. Future v2 packs ship with a parallel verifier code
  path; old v1 packs remain verifiable indefinitely.
- `tenant_id` is the workspace identifier the chain records belong to.
  Must match `tenant_id` (or its alias) inside every record in
  `chain.jsonl`. Mismatch ⇒ the verifier fails the pack as
  "tenant scope drift".
- `summary` and `created_at` are operator-facing metadata. Verifier
  reads them for logging only; they do not affect the verdict.

### chain.jsonl

One JSON object per line, newline-separated. Each object is a
**ProvenanceRecord** as defined in [`provenance.md`](provenance.md) and
the daemon's `src/utils/types.ts`. Blank lines are tolerated; comments
are not permitted (this is JSONL, not JSON5).

The chain is **strictly ordered**: record N+1's `previous_chain_hash`
MUST equal record N's `chain_hash`. The first record's
`previous_chain_hash` is the genesis sentinel `"0".repeat(64)`. The
daemon enforces this invariant on write; the verifier enforces it on
read.

### keys.json

Required if **any** record in `chain.jsonl` carries an `hmac` field
(i.e. G5 attestation was active during that record's write). If the
chain has no HMACs, `keys.json` MAY be omitted.

```json
{
  "version": 1,
  "workspace_id": "550e8400-e29b-41d4-a716-446655440000",
  "keys": [
    {
      "key_id": "11111111-2222-3333-4444-555555555555",
      "key_state": "active",
      "created_at": "2026-05-20T00:00:00Z",
      "rotated_at": null,
      "revoked_at": null,
      "encrypted_dek_hex": "abc123...",
      "nonce_hex": "112233445566778899aabbcc",
      "auth_tag_hex": "00112233445566778899aabbccddeeff"
    }
  ]
}
```

Each key entry contains the **encrypted DEK** wrapped under the
workspace KEK (AES-256-GCM). The KEK itself is **not in the pack** —
the customer receives it out-of-band (via SOC2-audited handoff, an
encrypted email, a 1Password share, etc.) and supplies it at verify
time via `wotw-verify --workspace-key <kek-hex-or-base64>`.

Key fields:

| Field | Meaning |
|---|---|
| `key_id` | UUID; matches the `key_id` propagated on each ProvenanceRecord that used this DEK. |
| `key_state` | `active`, `rotating`, `archived`, or `revoked`. Revoked DEKs are deliberately skipped during KEK rotation. |
| `created_at` | ISO-8601. When the DEK was minted. |
| `rotated_at` | ISO-8601 or null. When the DEK moved from `active` → `rotating`. |
| `revoked_at` | ISO-8601 or null. When the DEK was revoked. |
| `encrypted_dek_hex` | AES-256-GCM ciphertext, hex-encoded. Plaintext DEK is 32 bytes. |
| `nonce_hex` | 12-byte GCM IV, hex-encoded. |
| `auth_tag_hex` | 16-byte GCM authentication tag, hex-encoded. |

The triple (`encrypted_dek_hex`, `nonce_hex`, `auth_tag_hex`) is what
the verifier feeds to its AES-256-GCM unwrap. Daemon-side, these come
straight from the `workspace_keys` SQLite table in
`~/.wotw/<tenant>/keys.db`.

### content/

**Optional.** Currently unused by the v1 verifier. Reserved for a
future capability where the verifier recomputes content hashes from
the on-disk wiki bytes (not just the chain's recorded
`content_hash`). Tenants that want to support this in future packs
should include `wiki/` bytes under `content/wiki/` mirroring their
layout.

For v1, the verifier ignores `content/` if present. Including it does
not break anything; omitting it does not affect the verdict.

## Daemon-side write guarantees

When the daemon writes a Compliance Pack (CT4.01 endpoint, when shipped),
it commits to these invariants:

1. **Atomic export.** The pack is built in a temp directory, then moved
   into place via a single `rename`. The verifier never sees a partial
   pack.
2. **Chain monotonicity.** The exported `chain.jsonl` is a strict prefix
   of the daemon's live chain — never re-ordered, never re-encoded,
   never canonical-JSON-modified at export. Byte-for-byte the same
   lines the daemon appended to `~/.wotw/<tenant>/provenance-chain.jsonl`.
3. **Keys for what's in the chain.** `keys.json` includes a key entry
   for every distinct `key_id` referenced by any record's HMAC in the
   exported chain range. No more, no less.
4. **No plaintext DEK.** The daemon does not — and cannot — write the
   plaintext DEK into the pack. `keys.json` only carries the AES-GCM
   ciphertext. The KEK is the customer's responsibility.
5. **No content leakage.** Pack export does not include `wiki/`
   markdown content unless the operator explicitly opts in via
   `pack.include_content: true` in `wotw.config.yaml`. The default is
   chain-only; opt in is a separate operator decision.

## Verifier read-side semantics

The customer runs:

```bash
wotw-verify --workspace-key <kek> <pack-path>
```

For each record in `chain.jsonl`, the verifier:

1. Recomputes the canonical-JSON serialization (per
   [`provenance.md`](provenance.md) and [`src/provenance/hash.ts`](../src/provenance/hash.ts)).
2. Recomputes `sha256(canonical_payload)`; this MUST equal `id`.
3. Recomputes `sha256(previous_chain_hash || id)`; this MUST equal
   `chain_hash`.
4. Recomputes `previous_chain_hash`-linkage to record N-1.
5. If the record carries `hmac` and `key_id`:
   - Looks up the matching key in `keys.json`.
   - Unwraps the DEK via AES-256-GCM with the operator-supplied KEK.
   - Recomputes `HMAC-SHA256(DEK, canonical_payload)`; this MUST equal
     the record's `hmac`.
6. Classifies the record's status:
   - `attested` — all checks pass + HMAC verified
   - `chain-valid` — all chain checks pass + record has no HMAC
   - `failed` — any check fails

The exit code is `0` if every record is `attested` or `chain-valid`;
non-zero on any `failed`. JSON output is available via `--json`.

The verifier's canonical-JSON encoder is **byte-identical** with the
daemon's `canonicalJson` from `src/provenance/hash.ts`. This identity
is asserted at compile time in `wotw-verify/internal/canonical/canonical_test.go`
(see `TestByteIdentityWithDaemonRuntime`).

## Backward / forward compatibility

The wire format is locked at v1. Practical consequences:

- **Forward compat (new daemons + old v1 verifier):** the daemon may
  add optional fields to ProvenanceRecord that the v1 verifier ignores.
  These fields are stored on the record but **excluded from the
  canonical payload** — so old verifiers compute the same `id` and
  `chain_hash` as new daemons. See `key_id`, `fact_hashes_*`, and
  optional HMAC for the three current applications of this pattern.
- **Backward compat (old daemons + new v1 verifier):** pre-G5 records
  (no `hmac`, no `key_id`) classify as `chain-valid` rather than
  `failed`. The verifier was designed to accept the v0.6 / v0.7 / v0.8.0
  chain bytes without modification.
- **Major version bump (v2):** if a structural change is needed
  (different canonical encoding, different chain algorithm, additional
  required fields) it ships as `manifest.json::version: 2`. The
  verifier's v1 code path stays in place and refuses v2 packs with a
  loud error; a parallel v2 code path is added. v1 packs remain
  verifiable forever.

## What this format is NOT

- **Not a wiki export.** `wiki/` bytes are excluded by default.
  Compliance Pack carries the proof, not the source content.
- **Not signed with cosign.** Cosign signs `wotw-verify` releases,
  not Pack artifacts. The Pack itself is verified by chain-hash
  recompute + HMAC under tenant-managed keys, which is a strictly
  stronger guarantee than detached cosign signatures (the issuer
  cannot retroactively re-sign without re-issuing every DEK).
- **Not the marketplace artifact.** Pack-as-marketplace-object is
  the artifact-layer abstraction — same wire bytes, plus
  attribution / royalty / discovery metadata that ride on top.
  The wire format is the substrate; the marketplace is the
  superstructure.

## See also

- [`provenance.md`](provenance.md) — ProvenanceRecord schema +
  canonical-JSON rules.
- [`PASS-018-G5-CLOSURE.md`](../PASS-018-G5-CLOSURE.md) §4 — the
  frozen verifier contract.
- [`PASS-019-G5-COMPLETION.md`](../PASS-019-G5-COMPLETION.md) — KEK
  rotation + DEK auto-archive operational completeness.
- [`wotw-verify/docs/verification-protocol.md`](https://github.com/3030-Labs/wotw-verify/blob/main/docs/verification-protocol.md) —
  the canonical spec on the verifier side. **If this daemon-side doc
  and the verifier-side doc disagree, the verifier-side doc wins.**
- `wotw-artifact-layer-prd.md` — marketplace semantics (separate scope).
