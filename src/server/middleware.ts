/**
 * HTTP middleware used by the MCP server: auth token check, simple rate
 * limit (token bucket per IP), structured request logging.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import type { Principal, TokenStore } from "../multi-user/token-store.js";

/**
 * Constant-time string comparison used by the legacy single-token auth
 * branch (F-7). The multi-user `TokenStore` documents why it skips
 * timing-safe compare for `wotw_<64hex>` tokens, but the legacy path
 * accepts arbitrary operator-chosen strings that may be short or
 * low-entropy, so a network-level timing oracle here would be a real
 * leak. We pad the length-mismatch branch with a dummy `timingSafeEqual`
 * call so the running time of the false-return path is independent of
 * which input was longer.
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

export interface MiddlewareOptions {
  /**
   * Legacy single-token auth. When set, requests must present this exact
   * Bearer token. Ignored if `tokenStore` is provided.
   */
  authToken: string | null;
  /**
   * Multi-user token store. When present, Bearer tokens are looked up in
   * the store and the resulting principal is attached to the request.
   */
  tokenStore?: TokenStore | null;
  rateLimitRpm: number;
  /**
   * When true, trust `X-Forwarded-For` for client IP. When false
   * (default), always use `req.socket.remoteAddress`.
   */
  trustProxy?: boolean;
}

/**
 * Result of running middleware: whether to continue, and if so which
 * principal (if any) was authenticated.
 */
export interface MiddlewareResult {
  ok: boolean;
  principal: Principal | null;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Simple in-memory token-bucket rate limiter keyed by client IP.
 * Refills at rateLimitRpm / 60 tokens per second.
 */
export class RateLimiter {
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private buckets = new Map<string, Bucket>();

  constructor(ratePerMinute: number) {
    this.capacity = Math.max(1, ratePerMinute);
    this.refillPerMs = this.capacity / 60_000;
  }

  /**
   * Attempt to consume one token for the given key. Returns true if allowed.
   */
  take(key: string): boolean {
    const now = Date.now();
    const existing = this.buckets.get(key);
    if (!existing) {
      this.buckets.set(key, { tokens: this.capacity - 1, updatedAt: now });
      return true;
    }
    const elapsed = now - existing.updatedAt;
    existing.tokens = Math.min(this.capacity, existing.tokens + elapsed * this.refillPerMs);
    existing.updatedAt = now;
    if (existing.tokens < 1) return false;
    existing.tokens -= 1;
    return true;
  }

  /** Prune old entries (call periodically if long-running). */
  sweep(maxIdleMs: number): void {
    const cutoff = Date.now() - maxIdleMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }
}

/**
 * Run the pre-request middleware chain. Returns `{ ok: true, principal }` if
 * the caller should continue handling the request, `{ ok: false }` if it has
 * already been responded to (auth failure, rate limit).
 *
 * The returned principal reflects multi-user auth: if a TokenStore is
 * configured, it resolves the Bearer token to a user. Single-user mode
 * (legacy `authToken`) returns `{ user: "default" }` on success, or a
 * null principal when no auth is configured at all.
 */
export function runMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  opts: MiddlewareOptions,
  limiter: RateLimiter,
): MiddlewareResult {
  const log = getLogger("http");
  const clientIp = extractClientIp(req, opts.trustProxy === true);

  // Rate limit first so a flood of 401s doesn't DoS us either.
  if (!limiter.take(clientIp)) {
    res.writeHead(429, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "rate limit exceeded" }));
    log.warn({ clientIp, path: req.url }, "rate limited");
    return { ok: false, principal: null };
  }

  let principal: Principal | null = null;

  // Multi-user auth takes precedence when a token store is configured.
  if (opts.tokenStore) {
    const provided = extractBearer(req);
    if (!provided) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      log.warn({ clientIp, path: req.url }, "missing bearer token");
      return { ok: false, principal: null };
    }
    const found = opts.tokenStore.authenticate(provided);
    if (!found) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      log.warn({ clientIp, path: req.url }, "unknown token");
      return { ok: false, principal: null };
    }
    principal = found;
  } else if (opts.authToken) {
    // Single-token legacy mode. F-7: use a constant-time comparison
    // because the operator-chosen token may be short or low-entropy.
    const provided = extractBearer(req) ?? "";
    if (!safeEqual(provided, opts.authToken)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      log.warn({ clientIp, path: req.url }, "unauthorized request");
      return { ok: false, principal: null };
    }
    principal = { user: "default" };
  }

  log.debug({ clientIp, method: req.method, path: req.url, user: principal?.user }, "request");
  return { ok: true, principal };
}

function extractBearer(req: IncomingMessage): string | null {
  const h = req.headers["authorization"];
  if (typeof h !== "string") return null;
  if (!h.toLowerCase().startsWith("bearer ")) return null;
  return h.slice(7).trim() || null;
}

function extractClientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string") return fwd.split(",")[0]?.trim() ?? "unknown";
  }
  return req.socket.remoteAddress ?? "unknown";
}
