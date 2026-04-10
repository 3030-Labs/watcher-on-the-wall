/**
 * Unit tests for server/middleware.ts: RateLimiter token bucket and auth flow.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { RateLimiter, runMiddleware } from "../../src/server/middleware.js";

function mockRequest(
  opts: {
    authorization?: string;
    forwarded?: string;
    remoteAddress?: string;
  } = {},
): IncomingMessage {
  return {
    url: "/mcp",
    method: "POST",
    headers: {
      authorization: opts.authorization,
      "x-forwarded-for": opts.forwarded,
    },
    socket: { remoteAddress: opts.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function mockResponse(): {
  res: ServerResponse;
  statusCode: number | null;
  body: string | null;
} {
  const state = { statusCode: null as number | null, body: null as string | null };
  const res = {
    writeHead: (code: number) => {
      state.statusCode = code;
      return res;
    },
    end: (body?: string) => {
      state.body = body ?? null;
    },
  } as unknown as ServerResponse;
  return Object.assign(state, { res });
}

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("allows requests up to capacity", () => {
    const limiter = new RateLimiter(5);
    let allowed = 0;
    for (let i = 0; i < 5; i++) {
      if (limiter.take("ip1")) allowed++;
    }
    expect(allowed).toBe(5);
  });

  it("denies the next request after capacity is exhausted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00.000Z"));
    const limiter = new RateLimiter(3);
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(false);
    vi.useRealTimers();
  });

  it("refills tokens over time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00.000Z"));
    const limiter = new RateLimiter(60); // 1 token per second
    // Burn all tokens
    for (let i = 0; i < 60; i++) limiter.take("ip1");
    expect(limiter.take("ip1")).toBe(false);
    // Advance 2 seconds — should refill ~2 tokens
    vi.setSystemTime(new Date("2026-04-07T00:00:02.000Z"));
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(false);
    vi.useRealTimers();
  });

  it("tracks different keys separately", () => {
    const limiter = new RateLimiter(1);
    expect(limiter.take("ip1")).toBe(true);
    expect(limiter.take("ip1")).toBe(false);
    expect(limiter.take("ip2")).toBe(true);
  });

  it("sweep() evicts idle entries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-07T00:00:00.000Z"));
    const limiter = new RateLimiter(10);
    limiter.take("ip1");
    vi.setSystemTime(new Date("2026-04-07T00:05:00.000Z"));
    limiter.take("ip2");
    // After 2min idle cutoff, ip1 should be pruned.
    limiter.sweep(2 * 60 * 1000);
    // Take from ip1 again — if evicted, we're starting fresh at full capacity.
    for (let i = 0; i < 10; i++) {
      expect(limiter.take("ip1")).toBe(true);
    }
    vi.useRealTimers();
  });
});

describe("runMiddleware", () => {
  it("returns true and does not write a response when allowed", () => {
    const limiter = new RateLimiter(10);
    const req = mockRequest();
    const r = mockResponse();
    const result = runMiddleware(req, r.res, { authToken: null, rateLimitRpm: 10 }, limiter);
    expect(result.ok).toBe(true);
    expect(result.principal).toBeNull();
    expect(r.statusCode).toBeNull();
  });

  it("returns 429 when rate limited", () => {
    const limiter = new RateLimiter(1);
    const req = mockRequest();
    // Exhaust the bucket with a prior take().
    limiter.take("127.0.0.1");
    const r = mockResponse();
    const result = runMiddleware(req, r.res, { authToken: null, rateLimitRpm: 1 }, limiter);
    expect(result.ok).toBe(false);
    expect(r.statusCode).toBe(429);
    expect(r.body).toContain("rate limit");
  });

  it("returns 401 when auth token is missing", () => {
    const limiter = new RateLimiter(100);
    const req = mockRequest();
    const r = mockResponse();
    const result = runMiddleware(req, r.res, { authToken: "secret", rateLimitRpm: 100 }, limiter);
    expect(result.ok).toBe(false);
    expect(r.statusCode).toBe(401);
  });

  it("returns 401 when auth token is wrong", () => {
    const limiter = new RateLimiter(100);
    const req = mockRequest({ authorization: "Bearer wrong" });
    const r = mockResponse();
    const result = runMiddleware(req, r.res, { authToken: "secret", rateLimitRpm: 100 }, limiter);
    expect(result.ok).toBe(false);
    expect(r.statusCode).toBe(401);
  });

  it("allows request when auth token matches and returns 'default' principal", () => {
    const limiter = new RateLimiter(100);
    const req = mockRequest({ authorization: "Bearer secret" });
    const r = mockResponse();
    const result = runMiddleware(req, r.res, { authToken: "secret", rateLimitRpm: 100 }, limiter);
    expect(result.ok).toBe(true);
    expect(result.principal).toEqual({ user: "default" });
    expect(r.statusCode).toBeNull();
  });

  it("legacy single-token auth still accepts the right token and rejects every wrong variant (F-7)", () => {
    // Behavioral contract for the timing-safe legacy auth comparison.
    // We don't measure timing — we just confirm that the swap from
    // `!==` to `safeEqual` did not change the accept/reject contract:
    //  - exact match → accepted, principal "default"
    //  - same length, different bytes → rejected
    //  - shorter prefix → rejected
    //  - longer extension → rejected
    //  - empty bearer → rejected
    //  - missing bearer → rejected
    const opts = { authToken: "secret-operator-token", rateLimitRpm: 100 };

    const cases: { name: string; auth: string | undefined; ok: boolean }[] = [
      { name: "exact match", auth: "Bearer secret-operator-token", ok: true },
      { name: "same length wrong bytes", auth: "Bearer secret-operator-tokeX", ok: false },
      { name: "shorter prefix", auth: "Bearer secret-operator-toke", ok: false },
      { name: "longer extension", auth: "Bearer secret-operator-tokens", ok: false },
      { name: "empty bearer", auth: "Bearer ", ok: false },
      { name: "missing header", auth: undefined, ok: false },
    ];

    for (const c of cases) {
      // Fresh limiter per case so rate limiting can never confound the result.
      const limiter = new RateLimiter(100);
      const req = mockRequest({ authorization: c.auth });
      const r = mockResponse();
      const result = runMiddleware(req, r.res, opts, limiter);
      if (c.ok) {
        expect(result.ok, `${c.name} should be allowed`).toBe(true);
        expect(result.principal).toEqual({ user: "default" });
        expect(r.statusCode).toBeNull();
      } else {
        expect(result.ok, `${c.name} should be rejected`).toBe(false);
        expect(r.statusCode).toBe(401);
      }
    }
  });

  it("extracts client IP from x-forwarded-for", () => {
    const limiter = new RateLimiter(1);
    // First request from proxied IP.
    const req1 = mockRequest({
      forwarded: "203.0.113.1, 198.51.100.1",
      remoteAddress: "127.0.0.1",
    });
    const r1 = mockResponse();
    expect(runMiddleware(req1, r1.res, { authToken: null, rateLimitRpm: 1 }, limiter).ok).toBe(
      true,
    );
    // Second request from same proxied IP hits the limit.
    const req2 = mockRequest({
      forwarded: "203.0.113.1, 198.51.100.1",
      remoteAddress: "127.0.0.1",
    });
    const r2 = mockResponse();
    expect(runMiddleware(req2, r2.res, { authToken: null, rateLimitRpm: 1 }, limiter).ok).toBe(
      false,
    );
    expect(r2.statusCode).toBe(429);
    // A different proxied IP should still be allowed.
    const req3 = mockRequest({
      forwarded: "203.0.113.2",
      remoteAddress: "127.0.0.1",
    });
    const r3 = mockResponse();
    expect(runMiddleware(req3, r3.res, { authToken: null, rateLimitRpm: 1 }, limiter).ok).toBe(
      true,
    );
  });

  it("authenticates via TokenStore when provided", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TokenStore } = await import("../../src/multi-user/token-store.js");
    const dir = mkdtempSync(join(tmpdir(), "wotw-mw-"));
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    const token = store.addUser("alice");

    const limiter = new RateLimiter(100);
    const req = mockRequest({ authorization: `Bearer ${token}` });
    const r = mockResponse();
    const result = runMiddleware(
      req,
      r.res,
      { authToken: null, tokenStore: store, rateLimitRpm: 100 },
      limiter,
    );
    expect(result.ok).toBe(true);
    expect(result.principal).toEqual({ user: "alice" });
  });

  it("rejects unknown token when TokenStore is configured", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { TokenStore } = await import("../../src/multi-user/token-store.js");
    const dir = mkdtempSync(join(tmpdir(), "wotw-mw-"));
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    store.addUser("alice");

    const limiter = new RateLimiter(100);
    const req = mockRequest({ authorization: "Bearer wotw_deadbeef" });
    const r = mockResponse();
    const result = runMiddleware(
      req,
      r.res,
      { authToken: null, tokenStore: store, rateLimitRpm: 100 },
      limiter,
    );
    expect(result.ok).toBe(false);
    expect(r.statusCode).toBe(401);
  });
});
