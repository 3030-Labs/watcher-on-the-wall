/**
 * Envelope encryption for workspace DEKs.
 *
 * Scheme: AES-256-GCM. The KEK is a 32-byte symmetric key held in a Fly
 * secret (env var `WOTW_WORKSPACE_KEK`, base64-encoded). Each DEK is
 * 32 random bytes, encrypted under the KEK with a fresh 12-byte nonce,
 * yielding ciphertext + nonce + 16-byte auth tag. Stored as three
 * separate BLOB columns in `workspace_keys` so callers don't need to
 * parse a concatenated layout.
 *
 * Security properties:
 * - AEAD via GCM authenticates the ciphertext: any tampering with the
 *   stored bytes is detected at decrypt time (auth tag mismatch throws).
 * - Nonce is per-encryption (random 12 bytes). Reuse risk negligible at
 *   the volumes a single daemon will ever produce.
 * - KEK never leaves the daemon process; it's read from env once at
 *   startup.
 * - DEK plaintext is held in process memory only; never logged, never
 *   serialized to disk, never sent over the wire.
 *
 * KEK rotation: deferred to a future pass (re-encrypt every DEK under
 * the new KEK in a single transaction). DEK rotation is in scope of
 * this pass — see `KeyStore.rotate()`.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { EnvelopeCiphertext } from "./types.js";

const KEK_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEK_BYTES = 32;
const ALGORITHM = "aes-256-gcm" as const;

/**
 * Parse the KEK from its env-var encoding. Accepts base64 (preferred)
 * or hex. Fails loud on wrong length or unparseable encoding so
 * misconfiguration is caught at startup, not at first encrypt.
 *
 * Returns a 32-byte Buffer.
 */
export function parseKek(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("WOTW_WORKSPACE_KEK is empty");
  }
  // Try base64 first. base64 of 32 bytes is 44 chars (with padding) or 43
  // (without). Hex of 32 bytes is 64 chars. Heuristic: if it's all hex,
  // treat as hex; otherwise try base64.
  let buf: Buffer | null = null;
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEK_BYTES * 2) {
    buf = Buffer.from(trimmed, "hex");
  } else {
    try {
      const decoded = Buffer.from(trimmed, "base64");
      if (decoded.length === KEK_BYTES) buf = decoded;
    } catch {
      // fall through
    }
  }
  if (!buf || buf.length !== KEK_BYTES) {
    throw new Error(
      `WOTW_WORKSPACE_KEK must decode to exactly ${KEK_BYTES} bytes (got base64 or hex of length ${trimmed.length}; decoded ${buf?.length ?? "n/a"} bytes)`,
    );
  }
  return buf;
}

/**
 * Read + parse the KEK from the environment. Throws if the env var is
 * absent or malformed.
 */
export function readKekFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const raw = env.WOTW_WORKSPACE_KEK;
  if (!raw) {
    throw new Error("WOTW_WORKSPACE_KEK is not set in environment");
  }
  return parseKek(raw);
}

/** Generate a fresh 32-byte DEK via the OS CSPRNG. */
export function generateDek(): Buffer {
  return randomBytes(DEK_BYTES);
}

/**
 * Encrypt a DEK under the KEK using AES-256-GCM with a fresh random
 * nonce. Returns the ciphertext, nonce, and 16-byte auth tag as
 * separate Buffers so the caller can store them in distinct columns.
 */
export function wrapDek(dek: Buffer, kek: Buffer): EnvelopeCiphertext {
  if (dek.length !== DEK_BYTES) {
    throw new Error(`DEK must be exactly ${DEK_BYTES} bytes (got ${dek.length})`);
  }
  if (kek.length !== KEK_BYTES) {
    throw new Error(`KEK must be exactly ${KEK_BYTES} bytes (got ${kek.length})`);
  }
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
  const auth_tag = cipher.getAuthTag();
  if (auth_tag.length !== AUTH_TAG_BYTES) {
    throw new Error(`unexpected AES-GCM auth tag length: ${auth_tag.length}`);
  }
  return { ciphertext, nonce, auth_tag };
}

/**
 * Decrypt an envelope back to the plaintext DEK. The auth_tag must
 * match exactly — any tampering with ciphertext, nonce, or tag throws.
 */
export function unwrapDek(env: EnvelopeCiphertext, kek: Buffer): Buffer {
  if (kek.length !== KEK_BYTES) {
    throw new Error(`KEK must be exactly ${KEK_BYTES} bytes (got ${kek.length})`);
  }
  if (env.nonce.length !== NONCE_BYTES) {
    throw new Error(`envelope nonce must be ${NONCE_BYTES} bytes (got ${env.nonce.length})`);
  }
  if (env.auth_tag.length !== AUTH_TAG_BYTES) {
    throw new Error(
      `envelope auth_tag must be ${AUTH_TAG_BYTES} bytes (got ${env.auth_tag.length})`,
    );
  }
  const decipher = createDecipheriv(ALGORITHM, kek, env.nonce);
  decipher.setAuthTag(env.auth_tag);
  const dek = Buffer.concat([decipher.update(env.ciphertext), decipher.final()]);
  if (dek.length !== DEK_BYTES) {
    throw new Error(`unwrapped DEK has wrong length: ${dek.length} (expected ${DEK_BYTES})`);
  }
  return dek;
}
