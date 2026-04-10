/**
 * Hashing utilities used by the provenance chain and other subsystems.
 * Hashes are SHA-256 over canonical JSON (recursively sorted keys, no
 * whitespace, UTF-8). The canonical form is deterministic across machines
 * and language runtimes so verification does not depend on JSON.stringify
 * key-order quirks.
 *
 * This module is the single source of truth for hashing in `wotw` —
 * `src/utils/hash.ts` was previously a second copy with overlapping and
 * subtly-different sync/async signatures for `sha256File`. That duplication
 * has been removed (L-DUP-1). Prefer named exports from this module
 * (`sha256`/`sha256Hex`, `sha256File`, `sha256FileSync`, `canonicalJson`,
 * `sha256Canonical`) throughout the codebase.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

/** Special value used as `previous_chain_hash` for the first record in a chain. */
export const GENESIS_HASH = "0".repeat(64);

/**
 * Produce a canonical JSON string for any JSON-serializable input.
 * Keys in every object are sorted lexicographically, recursively.
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

/**
 * Alias for {@link sha256Hex}. Kept for ergonomic call sites
 * (`sha256(contents)` reads more naturally than `sha256Hex(contents)` in
 * non-provenance code) and for the stable public API in `src/index.ts`.
 */
export const sha256 = sha256Hex;

/** SHA-256 of the canonical JSON form of a value. */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Alias for {@link sha256Canonical} — hashes the canonical JSON of a value. */
export const sha256Json = sha256Canonical;

/** Alias for {@link canonicalJson} — kept for the stable public API. */
export const stableStringify = canonicalJson;

/**
 * Synchronous SHA-256 of a file on disk. Reads the whole file into memory,
 * which is fine for wiki pages. Throws if the file does not exist — callers
 * that need ENOENT tolerance should use the async {@link sha256File} which
 * returns null. Used by the watcher's in-memory event classifier where
 * synchronous semantics simplify the seed flow.
 */
export function sha256FileSync(filePath: string): string {
  return sha256Hex(readFileSync(filePath));
}

/**
 * SHA-256 of a file on disk. Returns null if the file does not exist.
 * Reads the whole file into memory — fine for wiki pages which are small.
 */
export async function sha256File(path: string): Promise<string | null> {
  try {
    const buf = await readFile(path);
    return sha256Hex(buf);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Hash many files in parallel. Missing files map to null entries.
 * Used when recording the post-ingestion state of the wiki.
 */
export async function sha256Files(paths: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  await Promise.all(
    paths.map(async (p) => {
      const h = await sha256File(p);
      if (h !== null) out[p] = h;
    }),
  );
  return out;
}
