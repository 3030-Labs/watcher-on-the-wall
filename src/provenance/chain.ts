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
import type { ProvenanceRecord, OperationType, ModelId } from "../utils/types.js";
import { ensureDir, fileExists } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import { GENESIS_HASH, canonicalJson, sha256Canonical, sha256Hex } from "./hash.js";

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

  constructor(opts: { path: string }) {
    this.path = opts.path;
    this.nextSeq = 1;
    this.lastChainHash = GENESIS_HASH;
    this.lastId = null;
    this.totalRecords = 0;
    this.initialized = false;
    this.writeLock = Promise.resolve();
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
      const payload = {
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
      };
      // The record id is the SHA-256 of the canonical payload. That makes it
      // deterministic and content-addressable: two identical operations get
      // the same id regardless of who wrote them.
      const id = sha256Canonical(payload);
      // The chain hash is SHA-256 of `previous_chain_hash + id`. Hashing the
      // id (rather than the whole payload twice) keeps verification cheap.
      const chainHash = sha256Hex(previousChainHash + id);

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
