/**
 * Workspace-key substrate types. The daemon's per-workspace HMAC signing
 * keys (DEKs) are stored encrypted under a KEK from Fly secrets. This
 * module defines the shapes; storage lives in `./store.ts`, envelope
 * encryption in `./envelope.ts`.
 *
 * Per-workspace model:
 * - The daemon is per-tenant (one Fly Machine per tenant); workspace_id
 *   maps 1:1 to tenant_id today. The column is forward-compat for
 *   sub-workspaces (one tenant, many wikis) if that ever ships.
 * - At most one `active` DEK per workspace at a time.
 * - Rotation produces a new `active` and transitions the old to
 *   `rotating` (verify-only); after an overlap window it becomes
 *   `archived` (verify-only, no new appends).
 * - `revoked` is terminal-immediate (compromise response).
 */

/** Lifecycle state of a workspace DEK. */
export type WorkspaceKeyState = "active" | "rotating" | "archived" | "revoked";

/**
 * A workspace DEK record as stored. `encrypted_dek` is AES-256-GCM
 * ciphertext under the KEK; `nonce` is the 12-byte IV; `auth_tag` is
 * the 16-byte authentication tag. The plaintext DEK never lives on
 * disk — only in process memory after decryption.
 */
export interface WorkspaceKeyRecord {
  key_id: string;
  workspace_id: string;
  key_state: WorkspaceKeyState;
  encrypted_dek: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  created_at: string;
  rotated_at: string | null;
  revoked_at: string | null;
}

/**
 * A decrypted DEK + its lineage metadata. The `dek` field is a
 * 32-byte Buffer suitable for `createHmac("sha256", dek)`. Holding
 * this object alive holds the plaintext key in memory; callers
 * should not log it, serialize it, or send it over the wire.
 */
export interface ResolvedWorkspaceKey {
  key_id: string;
  workspace_id: string;
  key_state: WorkspaceKeyState;
  dek: Buffer;
}

/** Inputs for the wrap/unwrap envelope operations. */
export interface EnvelopeCiphertext {
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
}
