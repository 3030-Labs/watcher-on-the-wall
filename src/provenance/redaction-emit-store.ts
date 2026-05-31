/**
 * RedactionEmitStore — SQLite-backed durable queue for outbound
 * redaction events bound for wotw-cloud's /api/internal/redaction-log
 * endpoint (PASS-024 / CT3).
 *
 * Lives at `<wiki_root>/.wotw/redaction-emit.db`. Schema v1 is a single
 * table `pending_redaction_emits`; the never-delete discipline (rows
 * transition pending → sent → archived, never DELETEd) follows the same
 * shape as workspace_keys (see `src/keys/store.ts`).
 *
 * Lifecycle:
 *   1. enqueue() — called on every redaction occurrence in
 *      `src/ingestion/prompt-builder.ts`. Writes a 'pending' row FIRST,
 *      before any emission attempt. This is the durability guarantee:
 *      even if the daemon dies before POST, the event survives.
 *   2. listPending() — RedactionEmitWorker drains pending rows.
 *   3. markSent() — atomic bulk transition after a successful POST.
 *   4. markFailed() / markArchived() — failure path; archived rows stay
 *      in the table for forensic inspection (never deleted).
 *
 * Concurrency: better-sqlite3 is synchronous + single-connection. The
 * daemon's enqueue path is single-writer (one IngestionQueue active per
 * daemon); the worker tick is also single-threaded. No locking needed
 * within this class — SQLite WAL handles the read-during-write case
 * implicit in the worker-vs-enqueue interleave.
 *
 * Idempotency: event_id is a UUIDv4 generated at enqueue time and used
 * as PRIMARY KEY. A re-enqueue of the same logical event from a buggy
 * caller becomes a PK conflict instead of a silent duplicate. The cloud
 * endpoint does NOT currently dedup on payload — see FEATURE-PASS-011
 * F1 finding for the deferred cloud-side ON CONFLICT migration.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import {
  looksLikeNativeBindingFailure,
  nativeBindingLoadError,
} from "../utils/actionable-error.js";
import { ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS pending_redaction_emits (
    event_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_attempt_at TEXT,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','sent','archived'))
  );
  CREATE INDEX IF NOT EXISTS idx_pending_redaction_emits_drain
    ON pending_redaction_emits(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_pending_redaction_emits_workspace
    ON pending_redaction_emits(workspace_id, created_at);
`;

/**
 * The shape of one event-payload row as it will be sent to the cloud
 * inside the `events: [...]` array of the POST body. event_id is the
 * daemon's local primary key and is intentionally OMITTED from the
 * cloud payload — the current cloud schema has no place to put it
 * (FEATURE-PASS-011 F1).
 */
export interface RedactionEventPayload {
  /** ISO-8601 UTC timestamp of the redaction occurrence. */
  redacted_at: string;
  /** Cloud-whitelisted rule id (credential_pattern_01..10 | truncation_32kb). */
  rule_id: string;
  /** Absolute or vault-relative source file path the redaction fired on. */
  source_file_path: string;
  /** UTF-8 byte length of the redacted material. */
  redaction_byte_count: number;
}

export type RedactionEmitStatus = "pending" | "sent" | "archived";

export interface PendingRedactionRow {
  event_id: string;
  workspace_id: string;
  payload: RedactionEventPayload;
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  status: RedactionEmitStatus;
}

interface RawRow {
  event_id: string;
  workspace_id: string;
  payload_json: string;
  created_at: string;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  status: RedactionEmitStatus;
}

export interface RedactionEmitStoreOptions {
  /** Absolute path to the SQLite file. Ignored when `inMemory` is true. */
  path: string;
  /** When true, opens the DB in `:memory:` mode — used by unit tests. */
  inMemory?: boolean;
}

export class RedactionEmitStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(opts: RedactionEmitStoreOptions) {
    this.path = opts.path;
    if (!opts.inMemory) {
      ensureDirSync(dirname(this.path));
    }
    try {
      this.db = new Database(opts.inMemory ? ":memory:" : this.path);
    } catch (err) {
      if (looksLikeNativeBindingFailure(err)) {
        throw nativeBindingLoadError("better-sqlite3", err);
      }
      throw err;
    }
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const log = getLogger("redaction-emit-store");
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion === SCHEMA_VERSION) return;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `redaction-emit.db at ${this.path} is at schema version ${currentVersion} ` +
          `(newer than this daemon's ${SCHEMA_VERSION}) — refusing to downgrade`,
      );
    }
    log.info({ from: currentVersion, to: SCHEMA_VERSION }, "running redaction-emit.db migrations");
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Write a new 'pending' row. Returns the generated event_id. Caller
   * (prompt-builder) must call this BEFORE attempting cloud emission —
   * the SQLite append is the durability anchor.
   *
   * `now` is injected for testability; defaults to ISO 8601 now.
   */
  enqueue(
    workspaceId: string,
    payload: RedactionEventPayload,
    now: string = new Date().toISOString(),
  ): string {
    const event_id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO pending_redaction_emits
           (event_id, workspace_id, payload_json, created_at, attempts, status)
         VALUES (?, ?, ?, ?, 0, 'pending')`,
      )
      .run(event_id, workspaceId, JSON.stringify(payload), now);
    return event_id;
  }

  /**
   * List pending rows in creation order, capped at `limit`. The cloud
   * endpoint caps batches at 1000 events; the worker passes 1000 here
   * to fill each batch.
   */
  listPending(limit: number): PendingRedactionRow[] {
    const rows = this.db
      .prepare(
        `SELECT event_id, workspace_id, payload_json, created_at, attempts,
                last_attempt_at, last_error, status
           FROM pending_redaction_emits
          WHERE status = 'pending'
          ORDER BY created_at ASC, event_id ASC
          LIMIT ?`,
      )
      .all(limit) as RawRow[];
    return rows.map(this.toRow);
  }

  /**
   * Mark a batch of pending rows as 'sent' after a successful cloud
   * POST. Atomic transaction — partial failure rolls back. Returns the
   * number of rows that actually transitioned (pending → sent).
   *
   * Rows already in 'sent' state are no-ops; this is the idempotency
   * guarantee on the daemon side (re-drain after a crash where SQLite
   * commit hadn't flushed). Rows in 'archived' state are NOT touched —
   * those are forensic-final.
   */
  markSent(eventIds: readonly string[], now: string = new Date().toISOString()): number {
    if (eventIds.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE pending_redaction_emits
          SET status = 'sent', last_attempt_at = ?
        WHERE event_id = ? AND status = 'pending'`,
    );
    return this.db.transaction((ids: readonly string[]): number => {
      let changes = 0;
      for (const id of ids) {
        const result = update.run(now, id);
        changes += Number(result.changes);
      }
      return changes;
    })(eventIds);
  }

  /**
   * Increment attempts counter + record last_error for a batch that
   * failed to POST. Rows stay 'pending' so the next drain tick retries
   * them. Does NOT touch rows already in 'sent' or 'archived' state.
   */
  markFailed(
    eventIds: readonly string[],
    error: string,
    now: string = new Date().toISOString(),
  ): number {
    if (eventIds.length === 0) return 0;
    const update = this.db.prepare(
      `UPDATE pending_redaction_emits
          SET attempts = attempts + 1,
              last_attempt_at = ?,
              last_error = ?
        WHERE event_id = ? AND status = 'pending'`,
    );
    return this.db.transaction((ids: readonly string[]): number => {
      let changes = 0;
      for (const id of ids) {
        const result = update.run(now, error.slice(0, 500), id);
        changes += Number(result.changes);
      }
      return changes;
    })(eventIds);
  }

  /**
   * Move terminally-failed rows (attempts >= maxAttempts) to 'archived'.
   * Archived rows remain in the table for forensic inspection — never
   * deleted. Returns the list of event_ids that transitioned.
   *
   * Called by the worker after each failed batch to evict rows that
   * are stuck retrying forever. The cap matches the worker's
   * MAX_ATTEMPTS constant.
   */
  archiveExhausted(maxAttempts: number): string[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT event_id FROM pending_redaction_emits
             WHERE status = 'pending' AND attempts >= ?`,
        )
        .all(maxAttempts) as { event_id: string }[];
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.event_id);
      const placeholders = ids.map(() => "?").join(",");
      this.db
        .prepare(
          `UPDATE pending_redaction_emits SET status = 'archived'
             WHERE event_id IN (${placeholders}) AND status = 'pending'`,
        )
        .run(...ids);
      return ids;
    })();
  }

  /** Count rows by status. Useful for diagnostics + tests. */
  countByStatus(): Record<RedactionEmitStatus, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) as n FROM pending_redaction_emits GROUP BY status`)
      .all() as { status: RedactionEmitStatus; n: number }[];
    const out: Record<RedactionEmitStatus, number> = {
      pending: 0,
      sent: 0,
      archived: 0,
    };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /** Schema version (diagnostics + tests). */
  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** Close the underlying handle. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close();
  }

  private toRow(raw: RawRow): PendingRedactionRow {
    return {
      event_id: raw.event_id,
      workspace_id: raw.workspace_id,
      payload: JSON.parse(raw.payload_json) as RedactionEventPayload,
      created_at: raw.created_at,
      attempts: raw.attempts,
      last_attempt_at: raw.last_attempt_at,
      last_error: raw.last_error,
      status: raw.status,
    };
  }
}
