/**
 * SQLite-backed workspace key store. Persistent layer for the G5
 * end-to-end attestation substrate. Lives at `.wotw/keys.db` under
 * the wiki root.
 *
 * Each row is one DEK in its lifecycle. The plaintext DEK is never
 * stored — only the AES-256-GCM ciphertext under the KEK (held in a
 * Fly secret, see `./envelope.ts`). When the daemon needs a DEK for
 * signing or verifying, it unwraps from the row and caches the
 * plaintext in memory.
 *
 * Migrations follow the same `PRAGMA user_version` pattern as
 * `facts.db` from Pass B — see `src/facts/store.ts`. Schema v1 is
 * the initial workspace_keys table.
 *
 * Concurrency: better-sqlite3 is synchronous with a single
 * connection. The daemon is single-writer for chain mutations
 * (IngestionQueue concurrency 1, ProvenanceChain serialized by
 * writeLock); rotation calls share that single writer too.
 *
 * Pass 008 BYOK: KEK is read from env at construction time (via the
 * envelope module) and never logged. Plaintext DEKs returned by
 * `resolveById` / `active` must not be logged or transmitted by
 * callers; see envelope.ts for the threat model.
 */

import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import { generateDek, unwrapDek, wrapDek } from "./envelope.js";
import type { ResolvedWorkspaceKey, WorkspaceKeyRecord, WorkspaceKeyState } from "./types.js";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS workspace_keys (
    key_id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    key_state TEXT NOT NULL CHECK (key_state IN ('active','rotating','archived','revoked')),
    encrypted_dek BLOB NOT NULL,
    nonce BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    created_at TEXT NOT NULL,
    rotated_at TEXT,
    revoked_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_workspace_keys_workspace ON workspace_keys(workspace_id);
  CREATE INDEX IF NOT EXISTS idx_workspace_keys_state ON workspace_keys(workspace_id, key_state);
  -- At most one active key per workspace. Enforced at the DB level so a
  -- concurrent rotate() that interleaves wrongly cannot leave two active.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_keys_one_active
    ON workspace_keys(workspace_id)
    WHERE key_state = 'active';
`;

export interface KeyStoreOptions {
  path: string;
  /** KEK Buffer, 32 bytes. Required — never derived from env inside this module. */
  kek: Buffer;
  inMemory?: boolean;
}

type Row = {
  key_id: string;
  workspace_id: string;
  key_state: WorkspaceKeyState;
  encrypted_dek: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
};

/**
 * The workspace key store. All public methods are synchronous —
 * better-sqlite3 is sync, and the surrounding daemon awaits at higher
 * layers for async consistency.
 */
export class KeyStore {
  readonly path: string;
  private readonly db: Database.Database;
  private readonly kek: Buffer;
  /** Cache of decrypted DEKs keyed by key_id. Bounded by the small number of keys per workspace. */
  private readonly dekCache: Map<string, Buffer>;

  constructor(opts: KeyStoreOptions) {
    this.path = opts.path;
    this.kek = opts.kek;
    this.dekCache = new Map();
    if (!opts.inMemory) {
      ensureDirSync(dirname(this.path));
    }
    this.db = new Database(opts.inMemory ? ":memory:" : this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const log = getLogger("key-store");
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion === SCHEMA_VERSION) return;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `keys.db at ${this.path} is at schema version ${currentVersion} (newer than this daemon's ${SCHEMA_VERSION}) — refusing to downgrade`,
      );
    }
    log.info({ from: currentVersion, to: SCHEMA_VERSION }, "running keys.db migrations");
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Provision a brand-new active DEK for the workspace. Fails if an
   * active DEK already exists (caller should `active()` first and
   * skip provisioning if so).
   *
   * Returns the resolved key (plaintext DEK + lineage). The plaintext
   * stays in process memory; never serialize it.
   */
  provision(workspaceId: string, now: string = new Date().toISOString()): ResolvedWorkspaceKey {
    const existing = this.activeRow(workspaceId);
    if (existing) {
      throw new Error(
        `cannot provision: workspace ${workspaceId} already has an active key (${existing.key_id})`,
      );
    }
    const key_id = randomUUID();
    const dek = generateDek();
    const env = wrapDek(dek, this.kek);
    this.db
      .prepare(
        `INSERT INTO workspace_keys (key_id, workspace_id, key_state, encrypted_dek, nonce, auth_tag, created_at)
         VALUES (?, ?, 'active', ?, ?, ?, ?)`,
      )
      .run(key_id, workspaceId, env.ciphertext, env.nonce, env.auth_tag, now);
    this.dekCache.set(key_id, dek);
    return { key_id, workspace_id: workspaceId, key_state: "active", dek };
  }

  /**
   * Return the workspace's currently active DEK, or null if none.
   * Caches plaintext on first decrypt; subsequent calls are cheap.
   */
  active(workspaceId: string): ResolvedWorkspaceKey | null {
    const row = this.activeRow(workspaceId);
    if (!row) return null;
    return this.toResolved(row);
  }

  /**
   * Resolve a DEK by its key_id, across ALL states (active, rotating,
   * archived, revoked). Used by the verifier: it must check HMACs on
   * records signed under any historical key, including revoked ones
   * (revoke is forensic — verify still surfaces the records, the
   * operator decides whether to trust them).
   *
   * Returns null if no row matches. Throws if the row exists but the
   * envelope fails to decrypt (KEK mismatch or tampered ciphertext).
   */
  resolveById(keyId: string): ResolvedWorkspaceKey | null {
    const cached = this.dekCache.get(keyId);
    if (cached) {
      const row = this.db
        .prepare(`SELECT key_id, workspace_id, key_state FROM workspace_keys WHERE key_id = ?`)
        .get(keyId) as
        | { key_id: string; workspace_id: string; key_state: WorkspaceKeyState }
        | undefined;
      if (!row) return null;
      return { ...row, dek: cached };
    }
    const row = this.db.prepare(`SELECT * FROM workspace_keys WHERE key_id = ?`).get(keyId) as
      | Row
      | undefined;
    if (!row) return null;
    return this.toResolved(row);
  }

  /**
   * Rotate the workspace's active DEK. Atomically: provisions a new
   * active DEK and transitions the previous active to `rotating`
   * (with `rotated_at = now`). New appends sign under the new DEK;
   * verify still recognizes records signed by the `rotating` DEK
   * during the overlap window.
   *
   * Returns the new active key.
   */
  rotate(
    workspaceId: string,
    now: string = new Date().toISOString(),
  ): { previous: ResolvedWorkspaceKey | null; current: ResolvedWorkspaceKey } {
    return this.db.transaction(() => {
      const prevRow = this.activeRow(workspaceId);
      let previous: ResolvedWorkspaceKey | null = null;
      if (prevRow) {
        this.db
          .prepare(
            `UPDATE workspace_keys SET key_state = 'rotating', rotated_at = ? WHERE key_id = ?`,
          )
          .run(now, prevRow.key_id);
        previous = {
          key_id: prevRow.key_id,
          workspace_id: prevRow.workspace_id,
          key_state: "rotating",
          dek: this.unwrapWithCache(prevRow),
        };
      }
      const key_id = randomUUID();
      const dek = generateDek();
      const env = wrapDek(dek, this.kek);
      this.db
        .prepare(
          `INSERT INTO workspace_keys (key_id, workspace_id, key_state, encrypted_dek, nonce, auth_tag, created_at)
           VALUES (?, ?, 'active', ?, ?, ?, ?)`,
        )
        .run(key_id, workspaceId, env.ciphertext, env.nonce, env.auth_tag, now);
      this.dekCache.set(key_id, dek);
      const current: ResolvedWorkspaceKey = {
        key_id,
        workspace_id: workspaceId,
        key_state: "active",
        dek,
      };
      return { previous, current };
    })();
  }

  /**
   * Archive a `rotating` DEK after its overlap window expires. After
   * archive, the DEK is verify-only (no new appends signed under it,
   * but old records still verify). Idempotent: archiving an already-
   * archived key is a no-op.
   *
   * Returns true if a row transitioned, false if no-op.
   */
  archive(keyId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE workspace_keys SET key_state = 'archived' WHERE key_id = ? AND key_state = 'rotating'`,
      )
      .run(keyId);
    return Number(result.changes) > 0;
  }

  /**
   * Revoke a DEK from any state (active, rotating, archived).
   * `revoked` is terminal — records signed under this DEK still
   * verify cryptographically (the math doesn't care about state),
   * but operators see `revoked` and decide whether to trust those
   * records. Compromise response.
   *
   * Returns true if a row transitioned, false if no-op.
   */
  revoke(keyId: string, now: string = new Date().toISOString()): boolean {
    const result = this.db
      .prepare(
        `UPDATE workspace_keys SET key_state = 'revoked', revoked_at = ? WHERE key_id = ? AND key_state != 'revoked'`,
      )
      .run(now, keyId);
    return Number(result.changes) > 0;
  }

  /**
   * Return every row for the workspace, ordered by created_at ascending.
   * Includes encrypted_dek + nonce + auth_tag for forensic inspection;
   * decryption happens lazily via `resolveById`.
   */
  listAll(workspaceId: string): WorkspaceKeyRecord[] {
    return this.db
      .prepare(
        `SELECT key_id, workspace_id, key_state, encrypted_dek, nonce, auth_tag, created_at, rotated_at, revoked_at
         FROM workspace_keys WHERE workspace_id = ? ORDER BY created_at ASC`,
      )
      .all(workspaceId) as WorkspaceKeyRecord[];
  }

  /** Count keys for a workspace by state. */
  countByState(workspaceId: string): Record<WorkspaceKeyState, number> {
    const rows = this.db
      .prepare(
        `SELECT key_state, COUNT(*) as n FROM workspace_keys WHERE workspace_id = ? GROUP BY key_state`,
      )
      .all(workspaceId) as { key_state: WorkspaceKeyState; n: number }[];
    const out: Record<WorkspaceKeyState, number> = {
      active: 0,
      rotating: 0,
      archived: 0,
      revoked: 0,
    };
    for (const r of rows) out[r.key_state] = r.n;
    return out;
  }

  /** Schema version (cheap, used by tests + diagnostics). */
  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** Close the underlying handle. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close();
    this.dekCache.clear();
  }

  private activeRow(workspaceId: string): Row | undefined {
    return this.db
      .prepare(
        `SELECT * FROM workspace_keys WHERE workspace_id = ? AND key_state = 'active' LIMIT 1`,
      )
      .get(workspaceId) as Row | undefined;
  }

  private toResolved(row: Row): ResolvedWorkspaceKey {
    return {
      key_id: row.key_id,
      workspace_id: row.workspace_id,
      key_state: row.key_state,
      dek: this.unwrapWithCache(row),
    };
  }

  private unwrapWithCache(row: Row): Buffer {
    const cached = this.dekCache.get(row.key_id);
    if (cached) return cached;
    const dek = unwrapDek(
      { ciphertext: row.encrypted_dek, nonce: row.nonce, auth_tag: row.auth_tag },
      this.kek,
    );
    this.dekCache.set(row.key_id, dek);
    return dek;
  }
}
