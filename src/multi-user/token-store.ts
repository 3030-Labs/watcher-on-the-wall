/**
 * Token store for multi-user mode.
 *
 * In single-user mode the server authenticates Bearer tokens against a single
 * `config.server.auth_token` value. In multi-user mode we want several users
 * (or CLI clients) to share one daemon, each with their own distinct token.
 * The TokenStore owns that mapping.
 *
 * Persistence format is a JSON file at `{workspaces_dir}/tokens.json`:
 *
 *   {
 *     "version": 1,
 *     "tokens": {
 *       "tok_alice_...": { "user": "alice", "created": "2026-04-07T..." },
 *       "tok_bob_...":   { "user": "bob",   "created": "2026-04-07T..." }
 *     }
 *   }
 *
 * The store is loaded synchronously on startup so the HTTP server can
 * authenticate without awaiting a disk read on every request. Mutations
 * (add/revoke) are written atomically via the same temp-file-then-rename
 * pattern the wiki store uses.
 */
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { atomicWriteSync, ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";

export interface TokenInfo {
  user: string;
  created: string;
}

/** On-disk schema for the token file. */
interface TokenFile {
  version: 1;
  tokens: Record<string, TokenInfo>;
}

export interface TokenStoreOptions {
  /** Directory where `tokens.json` lives. */
  workspacesDir: string;
}

/**
 * Authenticated principal returned after a successful token lookup.
 * Currently just a user name; we model it as an object so future fields
 * (scopes, quotas, etc.) can be added without breaking callers.
 */
export interface Principal {
  user: string;
}

/**
 * In-memory cache of token → user mappings, backed by a JSON file.
 */
export class TokenStore {
  private readonly file: string;
  private readonly workspacesDir: string;
  private tokens: Map<string, TokenInfo> = new Map();

  constructor(opts: TokenStoreOptions) {
    this.workspacesDir = opts.workspacesDir;
    this.file = join(opts.workspacesDir, "tokens.json");
  }

  /**
   * Load the token file from disk if it exists. Creates an empty store
   * otherwise. Idempotent — safe to call repeatedly.
   */
  load(): void {
    ensureDirSync(this.workspacesDir);
    if (!existsSync(this.file)) {
      this.tokens = new Map();
      return;
    }
    const raw = readFileSync(this.file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      getLogger("token-store").error(
        { path: this.file },
        "token store file is corrupt — starting with empty store",
      );
      // Backup corrupt file for forensics
      try {
        copyFileSync(this.file, `${this.file}.corrupt.${Date.now()}`);
      } catch {
        /* best effort */
      }
      this.tokens = new Map();
      return;
    }
    const data = parsed as TokenFile;
    if (!data || typeof data !== "object" || !data.tokens) {
      this.tokens = new Map();
      return;
    }
    this.tokens = new Map(Object.entries(data.tokens));
  }

  /** Persist the current in-memory state atomically. */
  save(): void {
    const out: TokenFile = {
      version: 1,
      tokens: Object.fromEntries(this.tokens),
    };
    atomicWriteSync(this.file, JSON.stringify(out, null, 2) + "\n");
    chmodSync(this.file, 0o600);
  }

  /**
   * Look up a token. Returns the principal on success, or null if the
   * token is unknown.
   *
   * **Timing:** This is an O(1) `Map.get` — it is **not** a constant-time
   * comparison. That is intentional (L-SEC-1). The threat model is a
   * network-level timing side-channel that distinguishes "valid token"
   * from "invalid token", which an attacker would use to enumerate the
   * token space. Our tokens are `wotw_<64hex>` — 32 bytes (256 bits) of
   * CSPRNG entropy from `node:crypto.randomBytes`. At a generous 10^9
   * guesses per second, a brute-force search of that space would take
   * on the order of 10^58 years; even with a timing oracle that leaks a
   * single bit per attempt the search is still ~10^19 years. No
   * constant-time comparison could meaningfully improve that margin, so
   * we accept the O(1) lookup for simplicity. If the token length or
   * entropy is ever reduced, this tradeoff must be revisited.
   */
  authenticate(token: string): Principal | null {
    if (!token) return null;
    const info = this.tokens.get(token);
    if (!info) return null;
    return { user: info.user };
  }

  /**
   * Add a user and return the generated token. Tokens are random 32-byte
   * values hex-encoded. Overwrites any existing entry with the same user
   * name — previous tokens for that user are revoked.
   */
  addUser(user: string): string {
    if (!user || user.trim().length === 0) {
      throw new Error("user name must be non-empty");
    }
    const trimmed = user.trim();
    // Revoke prior tokens for the same user to enforce one active token per user.
    for (const [tok, info] of this.tokens) {
      if (info.user === trimmed) this.tokens.delete(tok);
    }
    const token = `wotw_${randomBytes(32).toString("hex")}`;
    this.tokens.set(token, {
      user: trimmed,
      created: new Date().toISOString(),
    });
    this.save();
    return token;
  }

  /** Revoke a token. Returns true if a token was actually removed. */
  revokeToken(token: string): boolean {
    const existed = this.tokens.delete(token);
    if (existed) this.save();
    return existed;
  }

  /** Revoke all tokens belonging to a user. Returns count revoked. */
  revokeUser(user: string): number {
    const needle = user.trim();
    let count = 0;
    for (const [tok, info] of this.tokens) {
      if (info.user === needle) {
        this.tokens.delete(tok);
        count++;
      }
    }
    if (count > 0) this.save();
    return count;
  }

  /** List all users with their token creation timestamps. */
  listUsers(): Array<{ user: string; created: string }> {
    return Array.from(this.tokens.values()).map((info) => ({
      user: info.user,
      created: info.created,
    }));
  }

  /** Number of active tokens. */
  size(): number {
    return this.tokens.size;
  }

  /** Clear all tokens (for tests or administrative reset). */
  clear(): void {
    this.tokens.clear();
    this.save();
  }
}
