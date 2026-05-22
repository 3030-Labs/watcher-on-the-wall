/**
 * Cryptographic provenance chain-hash logic. Single source of truth for
 * verifying provenance records produced by the wotw daemon (watcher-on-the-wall).
 *
 * The daemon writes each provenance record to an append-only JSONL file with:
 *   id = sha256(canonicalJson(payload))
 *   chain_hash = sha256(previous_chain_hash || id)
 * where `payload` is the record minus its own id and chain_hash.
 *
 * The daemon then syncs records to Supabase (provenance_records table). The
 * web UI's verify-chain endpoint imports this module to recompute and
 * cryptographically verify the chain — not just check referential
 * consistency of the stored prev_chain_hash field.
 *
 * Canonical algorithm: matches src/provenance/chain.ts +
 * src/provenance/hash.ts in the watcher-on-the-wall repo at v0.2.12
 * (commit efe1a83). Daemon-side migration to import from this shared
 * module is companion work — until that lands, the two copies MUST stay
 * byte-identical. Any change to canonicalJson, hash computation, or
 * payload field-set MUST land in both places in the same commit batch.
 */
import { createHash } from "node:crypto";

/** Special value used as previous_chain_hash for the first record in a chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Produce a canonical JSON string for any JSON-serializable input.
 * Keys in every object are sorted lexicographically, recursively.
 * Deterministic across machines and runtimes — required for hash
 * verification to be reliable.
 */
export function canonicalJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      sorted[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return sorted;
  };
  return JSON.stringify(normalize(value));
}

/** SHA-256 of a string or buffer, returned as hex. */
export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/** SHA-256 of the canonical JSON form of a value. */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/**
 * Shape of a provenance record as written by the daemon. Must match
 * src/utils/types.ts:ProvenanceRecord in the watcher-on-the-wall repo.
 */
export interface ProvenanceRecord {
  id: string;
  seq: number;
  timestamp: string;
  type: string;
  source_files: string[];
  source_hashes: string[];
  prompt_hash: string;
  model_id: string;
  response_hash: string;
  wiki_files_written: string[];
  wiki_file_hashes_after: Record<string, string>;
  previous_id: string | null;
  previous_chain_hash: string;
  chain_hash: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface VerificationError {
  seq: number;
  id: string;
  reason: string;
}

export interface VerificationResult {
  ok: boolean;
  totalRecords: number;
  verifiedRecords: number;
  errors: VerificationError[];
}

/**
 * Verify a chain of provenance records. Records must be ordered by seq
 * ascending. Returns a structured result describing every error
 * encountered.
 *
 * Verification checks per record:
 *   - seq increments by 1 from the previous record (or starts at 1)
 *   - previous_id matches the prior record's id (or null at start)
 *   - previous_chain_hash matches the prior record's chain_hash
 *     (or GENESIS_HASH at start)
 *   - id == sha256Canonical(payload) where payload = record minus
 *     id+chain_hash (cryptographic check — detects payload tampering)
 *   - chain_hash == sha256Hex(previous_chain_hash + id)
 *     (cryptographic check — detects chain_hash field tampering)
 *
 * The two cryptographic checks are what distinguish this from a naive
 * referential check on previous_chain_hash — they detect tampering that
 * also updates previous_chain_hash to match.
 */
export function verifyChain(records: ProvenanceRecord[]): VerificationResult {
  const errors: VerificationError[] = [];
  let prevChainHash = GENESIS_HASH;
  let prevId: string | null = null;
  let expectedSeq = 1;

  for (const r of records) {
    if (r.seq !== expectedSeq) {
      errors.push({
        seq: r.seq,
        id: r.id,
        reason: `seq mismatch: expected ${expectedSeq}, got ${r.seq}`,
      });
    }
    if (r.previous_id !== prevId) {
      errors.push({
        seq: r.seq,
        id: r.id,
        reason: `previous_id mismatch: expected ${prevId}, got ${r.previous_id}`,
      });
    }
    if (r.previous_chain_hash !== prevChainHash) {
      errors.push({
        seq: r.seq,
        id: r.id,
        reason: `previous_chain_hash mismatch: expected ${prevChainHash}, got ${r.previous_chain_hash}`,
      });
    }

    // Recompute id from payload (excluding id + chain_hash).
    // Field set must match daemon's append() in chain.ts.
    const payload: Record<string, unknown> = {
      seq: r.seq,
      timestamp: r.timestamp,
      type: r.type,
      source_files: r.source_files,
      source_hashes: r.source_hashes,
      prompt_hash: r.prompt_hash,
      model_id: r.model_id,
      response_hash: r.response_hash,
      wiki_files_written: r.wiki_files_written,
      wiki_file_hashes_after: r.wiki_file_hashes_after,
      previous_id: r.previous_id,
      previous_chain_hash: r.previous_chain_hash,
    };
    if (r.metadata !== undefined) payload.metadata = r.metadata;

    const expectedId = sha256Canonical(payload);
    if (expectedId !== r.id) {
      errors.push({
        seq: r.seq,
        id: r.id,
        reason: `id hash mismatch: expected ${expectedId}, got ${r.id}`,
      });
    }
    const expectedChainHash = sha256Hex(r.previous_chain_hash + r.id);
    if (expectedChainHash !== r.chain_hash) {
      errors.push({
        seq: r.seq,
        id: r.id,
        reason: `chain_hash mismatch: expected ${expectedChainHash}, got ${r.chain_hash}`,
      });
    }

    prevChainHash = r.chain_hash;
    prevId = r.id;
    expectedSeq = r.seq + 1;
  }

  return {
    ok: errors.length === 0,
    totalRecords: records.length,
    verifiedRecords: records.length - errors.length,
    errors,
  };
}
