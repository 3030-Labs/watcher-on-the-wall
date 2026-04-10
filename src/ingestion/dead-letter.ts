/**
 * Dead-letter queue. Records permanently-failed ingestion batches to a
 * JSONL file so operators can inspect and replay them. One record per
 * line; append-only. An empty-string config path disables the queue
 * entirely (every call becomes a no-op) — useful for tests.
 *
 * Wired by {@link src/ingestion/queue.ts}: on catch, the queue calls
 * `deadLetter.record(batch, err)`, logs ERROR, and continues. Surfaced
 * to the user via `wotw status` (count) and the `get_stats` MCP tool.
 */
import { appendFile, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { ensureDir, fileExists } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode } from "../utils/types.js";
import type { WatcherBatch } from "../watcher/index.js";

/**
 * A single failed-batch record as persisted to the JSONL file. The
 * `retry` field is always `false` today — we don't auto-retry — but the
 * field is reserved so a future replay command can flip it when the
 * operator marks a batch for re-ingestion.
 */
export interface DeadLetterRecord {
  timestamp: string;
  batch_id: string;
  files: string[];
  reason: "add" | "delete";
  mode: RuntimeMode;
  error: string;
  stack?: string;
  retry: boolean;
}

export interface DeadLetterOptions {
  /** Absolute path to the JSONL file. Empty string disables the queue. */
  path: string;
  /**
   * Runtime mode this batch ran under. Persisted with each record so the
   * operator can tell which execution mode produced the failure — useful
   * when the same wiki is used from a CLI machine and an API machine.
   */
  runtimeMode?: RuntimeMode;
}

/**
 * Append-only dead-letter sink. Every method is safe against a missing
 * path (empty string) and against I/O errors on the sink file — the
 * queue must never prevent the daemon from continuing.
 */
export class DeadLetterQueue {
  readonly path: string;
  private readonly runtimeMode: RuntimeMode;

  constructor(opts: DeadLetterOptions) {
    this.path = opts.path;
    this.runtimeMode = opts.runtimeMode ?? "api";
  }

  /** True if this queue actually persists anything. */
  get enabled(): boolean {
    return this.path.length > 0;
  }

  /**
   * Append a failure record. Never throws — a failing dead-letter sink
   * must not take the daemon down. Errors are logged at WARN so the
   * operator can still tell something went wrong with the ledger.
   */
  async record(
    batch: Pick<WatcherBatch, "id" | "paths">,
    error: unknown,
    reason: "add" | "delete" = "add",
  ): Promise<void> {
    if (!this.enabled) return;
    const log = getLogger("dead-letter");
    const err = toError(error);
    const record: DeadLetterRecord = {
      timestamp: new Date().toISOString(),
      batch_id: batch.id,
      files: [...batch.paths],
      reason,
      mode: this.runtimeMode,
      error: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      retry: false,
    };
    try {
      await ensureDir(dirname(this.path));
      await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
      log.error(
        {
          batchId: batch.id,
          files: record.files.length,
          reason,
          error: err.message,
        },
        "batch permanently failed — recorded to dead-letter queue. " +
          `Inspect with 'wotw status' or via get_stats; raw log: ${this.path}`,
      );
    } catch (writeErr) {
      log.warn({ err: writeErr, path: this.path }, "failed to append dead-letter record");
    }
  }

  /** Return the number of persisted failed batches (0 if disabled). */
  async count(): Promise<number> {
    if (!this.enabled || !fileExists(this.path)) return 0;
    try {
      const text = await readFile(this.path, "utf8");
      return text.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {
      return 0;
    }
  }

  /** Return the last N records (most recent last). 0 = all. */
  async list(limit = 0): Promise<DeadLetterRecord[]> {
    if (!this.enabled || !fileExists(this.path)) return [];
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch {
      return [];
    }
    const records: DeadLetterRecord[] = [];
    for (const rawLine of text.split("\n")) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as DeadLetterRecord);
      } catch {
        // Skip malformed lines silently — best-effort ledger.
      }
    }
    if (limit > 0 && records.length > limit) {
      return records.slice(records.length - limit);
    }
    return records;
  }

  /** Delete the ledger file. Idempotent. */
  async clear(): Promise<void> {
    if (!this.enabled) return;
    if (!fileExists(this.path)) return;
    await rm(this.path, { force: true });
  }
}

/** Coerce any thrown value to an Error so we can safely read message/stack. */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  if (typeof err === "string") return new Error(err);
  try {
    return new Error(JSON.stringify(err));
  } catch {
    return new Error(String(err));
  }
}
