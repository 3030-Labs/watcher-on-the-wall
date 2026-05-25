/**
 * Cryptographic provenance chain. Every operation that mutates (or answers
 * from) the wiki appends a single record to an append-only JSONL file.
 * Records form a hash chain: each entry's `previous_chain_hash` matches the
 * prior entry's `chain_hash`, so any tampering with past entries invalidates
 * the tail of the chain.
 *
 * File layout: one JSON object per line, newline-separated, no trailing
 * newline when empty. We never rewrite or truncate the file — history is
 * write-once. Rotation, if ever needed, is a separate concern outside this
 * module.
 *
 * Concurrency: the daemon is single-writer (IngestionQueue has concurrency 1,
 * QueryEngine is called from the MCP request handler which is naturally
 * serialized by Node's single-threaded event loop). We serialize all chain
 * operations behind an in-process mutex to guard against interleaved
 * appends from multiple subsystems.
 */
import { open, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProvenanceRecord, OperationType, ModelId } from "../utils/types.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import { GENESIS_HASH, canonicalJson, sha256Canonical, sha256Hex } from "./hash.js";
import type { KeyStore } from "../keys/store.js";

/**
 * Optional sink invoked fire-and-forget after a JSONL append succeeds.
 * Used by the daemon to mirror records to wotw-cloud's Supabase replica.
 * Sink failures MUST NOT throw — JSONL is canonical, the sink is a
 * sync-replica for UI consumption. See cloud-sink.ts.
 */
export interface ProvenanceSink {
  append(record: ProvenanceRecord): Promise<boolean>;
}

/** Fields a caller must supply when appending a new record. */
export interface ProvenanceAppendInput {
  type: OperationType;
  source_files: string[];
  source_hashes: string[];
  prompt_hash: string;
  model_id: ModelId;
  response_hash: string;
  wiki_files_written: string[];
  wiki_file_hashes_after: Record<string, string>;
  metadata?: Record<string, string | number | boolean>;
  /**
   * Review item 43: tenant_id when running in hosted mode. Folded into
   * the canonical payload so a record from tenant A cannot be replayed
   * as a record of tenant B without recomputing id + chain_hash + hmac.
   */
  tenant_id?: string;
  /**
   * Pass B (fact extraction): fact_hash strings added by this operation.
   * Stored on the record but NOT folded into the canonical payload — they
   * are best-effort metadata, not cryptographically attested, so new
   * daemons emitting these fields produce records that verify identically
   * under older daemons that don't know about them.
   */
  fact_hashes_added?: string[];
  /** Pass B: fact_hash strings superseded by this operation. */
  fact_hashes_superseded?: string[];
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
 * Append-only hash-chain of provenance records.
 *
 * Usage:
 * ```
 * const chain = new ProvenanceChain({ path: "/path/to/chain.jsonl" });
 * await chain.init();
 * await chain.append({ ... });
 * const result = await chain.verify();
 * ```
 */
export class ProvenanceChain {
  readonly path: string;
  private nextSeq: number;
  private lastChainHash: string;
  private lastId: string | null;
  private totalRecords: number;
  private initialized: boolean;
  /** Promise that serializes all append operations. */
  private writeLock: Promise<void>;
  /** Optional sync-replica sink (e.g., wotw-cloud Supabase). Fire-and-forget. */
  private sink: ProvenanceSink | null;
  /**
   * Review item 43: tenant_id folded into the canonical payload when set.
   * In hosted mode the daemon passes config.hosted.tenant_id; in interactive
   * mode this stays undefined and tenant_id is omitted from the payload
   * (backwards-compat — chains predating this change verify identically).
   */
  private readonly tenantId: string | undefined;
  /**
   * G5 closure (Pass 018, v0.8.2): workspace key store. When set, every
   * append signs the record's HMAC with the workspace's currently active
   * DEK and stamps `key_id` on the record so the verifier can look up
   * the right DEK after rotation. When null, falls back to the
   * single-key 4-tier resolution below (backwards-compat for chains
   * predating G5 closure).
   */
  private readonly keyStore: KeyStore | null;
  /** Workspace id used to look up DEKs in the key store. Defaults to tenantId. */
  private readonly workspaceId: string | undefined;
  /**
   * Review item 42 (backward-compat path): single-key fallback. Resolved
   * at construction when no `keyStore` is provided:
   *   1. Explicit opts.hmacKey
   *   2. process.env.WOTW_PROVENANCE_HMAC_KEY
   *   3. Derived from tenant_id (sha256("wotw-provenance-v1", tenant_id))
   *   4. undefined → no HMAC field on records (pre-G5)
   * Used by the verifier to validate records that have an `hmac` field
   * but no `key_id` (i.e., produced by a pre-v0.8.2 daemon).
   */
  private readonly hmacKey: string | undefined;

  constructor(opts: {
    path: string;
    sink?: ProvenanceSink | null;
    tenantId?: string;
    workspaceId?: string;
    keyStore?: KeyStore | null;
    hmacKey?: string;
  }) {
    this.path = opts.path;
    this.nextSeq = 1;
    this.lastChainHash = GENESIS_HASH;
    this.lastId = null;
    this.totalRecords = 0;
    this.initialized = false;
    this.writeLock = Promise.resolve();
    this.sink = opts.sink ?? null;
    this.tenantId = opts.tenantId;
    this.keyStore = opts.keyStore ?? null;
    this.workspaceId = opts.workspaceId ?? opts.tenantId;
    // Resolve fallback HMAC key per the documented preference order. Used
    // both as the signing key when no keyStore is provided, AND as the
    // backward-compat verification key for records lacking a key_id
    // (produced by a pre-v0.8.2 daemon).
    if (opts.hmacKey) {
      this.hmacKey = opts.hmacKey;
    } else if (process.env.WOTW_PROVENANCE_HMAC_KEY) {
      this.hmacKey = process.env.WOTW_PROVENANCE_HMAC_KEY;
    } else if (opts.tenantId) {
      this.hmacKey = createHmac("sha256", "wotw-provenance-v1").update(opts.tenantId).digest("hex");
    } else {
      this.hmacKey = undefined;
    }
  }

  /**
   * Prepare the chain for use. Creates the parent directory and reads the
   * tail of the file to recover the next sequence number and the last chain
   * hash. Safe to call multiple times.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    await ensureDir(dirname(this.path));
    if (!fileExists(this.path)) {
      // Touch an empty file so downstream `stat` calls succeed.
      const handle = await open(this.path, "a");
      await handle.close();
      this.initialized = true;
      return;
    }
    const records = await this.readAll();
    // Corruption detection: if the file has content but all records failed to parse,
    // the chain is corrupted and continuing would silently reset to genesis.
    if (records.length === 0) {
      const { stat: fsStat } = await import("node:fs/promises");
      try {
        const st = await fsStat(this.path);
        if (st.size > 0) {
          throw new Error(
            "provenance chain file exists but contains no valid records — file may be corrupted",
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes("provenance chain file exists")) throw err;
        // stat failure — file may have been deleted between exists check and stat
      }
    }
    this.totalRecords = records.length;
    if (records.length > 0) {
      const last = records[records.length - 1]!;
      // Review item 38: verify the tail record's own id + chain_hash
      // before adopting it. Pre-fix, init() read seq/chain_hash/id
      // without verifying — a tampered tail would propagate forward.
      // Always-on minimum-bar verify of just the tail; full chain
      // verify is gated by config.provenance.verify_on_startup (item 37).
      const tailPayload: Record<string, unknown> = {
        seq: last.seq,
        timestamp: last.timestamp,
        type: last.type,
        source_files: last.source_files,
        source_hashes: last.source_hashes,
        prompt_hash: last.prompt_hash,
        model_id: last.model_id,
        response_hash: last.response_hash,
        wiki_files_written: last.wiki_files_written,
        wiki_file_hashes_after: last.wiki_file_hashes_after,
        previous_id: last.previous_id,
        previous_chain_hash: last.previous_chain_hash,
      };
      if (last.metadata !== undefined) tailPayload.metadata = last.metadata;
      if (last.tenant_id !== undefined) tailPayload.tenant_id = last.tenant_id;
      const recomputedId = sha256Canonical(tailPayload);
      if (recomputedId !== last.id) {
        throw new Error(
          `provenance tail self-inconsistent: stored id=${last.id} but recomputed id=${recomputedId}. Refuse to continue.`,
        );
      }
      const recomputedChainHash = sha256Hex(`${last.previous_chain_hash}${last.id}`);
      if (recomputedChainHash !== last.chain_hash) {
        throw new Error(
          `provenance tail chain_hash inconsistent: stored=${last.chain_hash} recomputed=${recomputedChainHash}. Refuse to continue.`,
        );
      }
      // Tail HMAC verify (G5 closure, Pass 018). The tail is the most
      // likely place for tampering (an attacker who can't recompute the
      // whole chain at least tries to replace just the last record).
      // Check matches verify()'s logic — see verifyHmac().
      const hmacError = this.verifyHmac(last);
      if (hmacError) {
        throw new Error(
          `provenance tail hmac verification failed: ${hmacError.reason}. Refuse to continue.`,
        );
      }
      this.nextSeq = last.seq + 1;
      this.lastChainHash = last.chain_hash;
      this.lastId = last.id;
    }
    this.initialized = true;
  }

  /**
   * Append a new record to the chain. Computes `seq`, `previous_id`,
   * `previous_chain_hash`, `id` and `chain_hash` for the caller.
   *
   * Returns the fully-populated record that was written to disk.
   */
  async append(input: ProvenanceAppendInput): Promise<ProvenanceRecord> {
    if (!this.initialized) await this.init();
    const log = getLogger("provenance");

    // Serialize through the write lock so concurrent callers cannot
    // interleave and corrupt the hash chain.
    const release = await this.acquireLock();
    try {
      const seq = this.nextSeq;
      const previousId = this.lastId;
      const previousChainHash = this.lastChainHash;
      const timestamp = new Date().toISOString();

      // Build the payload whose hash becomes both `id` and part of `chain_hash`.
      // Review item 43: include tenant_id when present so cross-tenant
      // record confusion is detectable (record from tenant A cannot
      // match a verifier expecting tenant B without recomputing id).
      const effectiveTenantId = input.tenant_id ?? this.tenantId;
      const payload: Record<string, unknown> = {
        seq,
        timestamp,
        type: input.type,
        source_files: input.source_files,
        source_hashes: input.source_hashes,
        prompt_hash: input.prompt_hash,
        model_id: input.model_id,
        response_hash: input.response_hash,
        wiki_files_written: input.wiki_files_written,
        wiki_file_hashes_after: input.wiki_file_hashes_after,
        previous_id: previousId,
        previous_chain_hash: previousChainHash,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(effectiveTenantId ? { tenant_id: effectiveTenantId } : {}),
      };
      // The record id is the SHA-256 of the canonical payload. Deterministic
      // and content-addressable: identical operations get the same id.
      const id = sha256Canonical(payload);
      // The chain hash is SHA-256 of `previous_chain_hash + id`. Hashing the
      // id (rather than the whole payload twice) keeps verification cheap.
      const chainHash = sha256Hex(previousChainHash + id);
      // HMAC over `id || chain_hash`. Two paths:
      // 1. G5-closed (Pass 018, v0.8.2+): keyStore is set + workspaceId
      //    resolves to an active DEK. Sign with the DEK, stamp key_id.
      //    Verifier looks up the same DEK via key_id even after rotation.
      // 2. Backward-compat (G5-scaffolding or pre-G5): keyStore null,
      //    use the single-key fallback resolved at construction. No
      //    key_id on the record. Verifier falls back to the same
      //    single-key resolution at verify time.
      let hmac: string | undefined;
      let keyId: string | undefined;
      if (this.keyStore && this.workspaceId) {
        const resolved = this.keyStore.active(this.workspaceId);
        if (resolved) {
          hmac = createHmac("sha256", resolved.dek).update(`${id}|${chainHash}`).digest("hex");
          keyId = resolved.key_id;
        }
      }
      if (!hmac && this.hmacKey) {
        hmac = createHmac("sha256", this.hmacKey).update(`${id}|${chainHash}`).digest("hex");
      }

      const record: ProvenanceRecord = {
        id,
        seq,
        timestamp,
        type: input.type,
        source_files: input.source_files,
        source_hashes: input.source_hashes,
        prompt_hash: input.prompt_hash,
        model_id: input.model_id,
        response_hash: input.response_hash,
        wiki_files_written: input.wiki_files_written,
        wiki_file_hashes_after: input.wiki_file_hashes_after,
        previous_id: previousId,
        previous_chain_hash: previousChainHash,
        chain_hash: chainHash,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(effectiveTenantId ? { tenant_id: effectiveTenantId } : {}),
        ...(hmac ? { hmac } : {}),
        ...(keyId ? { key_id: keyId } : {}),
        ...(input.fact_hashes_added && input.fact_hashes_added.length > 0
          ? { fact_hashes_added: input.fact_hashes_added }
          : {}),
        ...(input.fact_hashes_superseded && input.fact_hashes_superseded.length > 0
          ? { fact_hashes_superseded: input.fact_hashes_superseded }
          : {}),
      };

      // Append a single line. We open in append mode so multiple processes
      // on POSIX are reasonably safe (single-writer assumption still holds).
      const line = `${JSON.stringify(record)}\n`;
      const handle = await open(this.path, "a");
      try {
        await handle.write(line);
        await handle.sync();
      } finally {
        await handle.close();
      }

      // Update in-memory state only after a successful write.
      this.nextSeq = seq + 1;
      this.lastChainHash = chainHash;
      this.lastId = id;
      this.totalRecords += 1;

      log.info(
        { seq, type: input.type, id: id.slice(0, 12), sources: input.source_files.length },
        "provenance record appended",
      );

      // Fire-and-forget cloud sync. JSONL is canonical; sink failures are
      // logged but never throw. Run outside the writeLock release path so
      // a slow sink doesn't serialize the daemon's append throughput.
      if (this.sink) {
        const sink = this.sink;
        void sink
          .append(record)
          .catch((err) =>
            log.warn(
              { seq, err: err instanceof Error ? err.message : String(err) },
              "provenance sink unexpected error",
            ),
          );
      }

      return record;
    } finally {
      release();
    }
  }

  /**
   * Walk the entire file and verify every record. Returns a detailed
   * result describing the first error encountered, if any.
   */
  async verify(): Promise<VerificationResult> {
    const records = await this.readAll();
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

      // Recompute id and chain_hash from the record's own content.
      // Canonical payload must EXACTLY match what append() built (lines
      // ~248-263), or recomputed id diverges. Same fields, same
      // conditional-inclusion of metadata + tenant_id. Fields that were
      // deliberately excluded by canonical-payload-exclusion (hmac,
      // key_id, fact_hashes_*) MUST stay excluded here too — that's how
      // forward/backward compat works.
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
      if (r.tenant_id !== undefined) payload.tenant_id = r.tenant_id;
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

      // HMAC verification (G5 closure, Pass 018). Two paths:
      // - key_id present → look up DEK via keyStore.resolveById(); the
      //   resolved DEK could be in any state (active/rotating/archived/
      //   revoked). Revoked records still verify cryptographically;
      //   operators decide whether to trust them based on key_state.
      // - key_id absent, hmac present → backward-compat with the
      //   single-key 4-tier resolution from the G5-scaffolding commit
      //   `1875925`. Uses this.hmacKey.
      // - hmac absent → pre-G5 record, no check.
      if (r.hmac !== undefined) {
        const hmacError = this.verifyHmac(r);
        if (hmacError) errors.push(hmacError);
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

  /** Read every record in the chain file. */
  async readAll(): Promise<ProvenanceRecord[]> {
    if (!fileExists(this.path)) return [];
    const text = await readFile(this.path, "utf8");
    const out: ProvenanceRecord[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ProvenanceRecord);
      } catch (err) {
        getLogger("provenance").warn({ line: i + 1, err }, "skipping malformed chain line");
      }
    }
    return out;
  }

  /** Return the last N records (most recent last). */
  async readRecent(limit: number): Promise<ProvenanceRecord[]> {
    const all = await this.readAll();
    if (limit >= all.length) return all;
    return all.slice(all.length - limit);
  }

  /**
   * Return every record that touched a specific wiki file, ordered oldest
   * to newest. A record "touches" a file if the file appears in
   * `wiki_files_written` or `source_files`.
   */
  async recordsFor(filePath: string): Promise<ProvenanceRecord[]> {
    const all = await this.readAll();
    return all.filter(
      (r) => r.wiki_files_written.includes(filePath) || r.source_files.includes(filePath),
    );
  }

  /** Total number of records in the chain. */
  count(): number {
    return this.totalRecords;
  }

  /** Current tail-of-chain hash (GENESIS_HASH if empty). */
  head(): string {
    return this.lastChainHash;
  }

  /** File size of the chain on disk in bytes, or 0 if missing. */
  async sizeBytes(): Promise<number> {
    try {
      const s = await stat(this.path);
      return s.size;
    } catch {
      return 0;
    }
  }

  /**
   * Compute a dump signature: SHA-256 over every record's canonical JSON
   * concatenated in-order. Useful as a compact fingerprint of the whole
   * chain for external comparison.
   */
  async signature(): Promise<string> {
    const records = await this.readAll();
    return sha256Hex(records.map((r) => canonicalJson(r)).join("\n"));
  }

  /**
   * Recompute the HMAC for a record and compare against the stored
   * value. Returns null on success, a VerificationError on mismatch.
   *
   * Key resolution mirrors append():
   * 1. record.key_id set + keyStore available → resolve DEK by key_id
   *    across all states. Missing row OR keyStore-absent → error.
   * 2. record.key_id absent + this.hmacKey set → backward-compat,
   *    use the single-key fallback.
   * 3. Neither → error (record claims hmac but verifier can't resolve a key).
   */
  private verifyHmac(r: ProvenanceRecord): VerificationError | null {
    if (r.hmac === undefined) return null;
    let key: Buffer | string | undefined;
    let keyDescription = "";
    if (r.key_id !== undefined) {
      if (!this.keyStore) {
        return {
          seq: r.seq,
          id: r.id,
          reason: `record carries key_id=${r.key_id.slice(0, 8)}… but daemon has no keyStore configured`,
        };
      }
      const resolved = this.keyStore.resolveById(r.key_id);
      if (!resolved) {
        return {
          seq: r.seq,
          id: r.id,
          reason: `record key_id=${r.key_id.slice(0, 8)}… not found in keyStore`,
        };
      }
      key = resolved.dek;
      keyDescription = `key_id=${r.key_id.slice(0, 8)}… state=${resolved.key_state}`;
    } else if (this.hmacKey) {
      key = this.hmacKey;
      keyDescription = "fallback 4-tier resolution";
    } else {
      return {
        seq: r.seq,
        id: r.id,
        reason: "record carries hmac but verifier has no key (no keyStore, no fallback hmacKey)",
      };
    }
    const expected = createHmac("sha256", key).update(`${r.id}|${r.chain_hash}`).digest();
    const stored = Buffer.from(r.hmac, "hex");
    if (stored.length !== expected.length) {
      return {
        seq: r.seq,
        id: r.id,
        reason: `hmac length mismatch: stored ${stored.length} bytes vs expected ${expected.length}`,
      };
    }
    if (!timingSafeEqual(stored, expected)) {
      return {
        seq: r.seq,
        id: r.id,
        reason: `hmac mismatch (${keyDescription})`,
      };
    }
    return null;
  }

  /**
   * Acquire the write lock. Returns a release callback. Implements a minimal
   * promise-chained mutex so callers automatically queue up behind each
   * other without races.
   */
  private async acquireLock(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.writeLock;
    this.writeLock = this.writeLock.then(() => next);
    await previous;
    return release;
  }
}
