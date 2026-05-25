/**
 * Unit tests for the DekArchiveScheduler (PASS-019 Part C).
 *
 * Covers:
 * - runOnce() archives only post-overlap rotating DEKs
 * - injected `now` lets the test fast-forward without real timers
 * - overlap window respects options.overlapHours, then env, then default
 * - lifecycle: start() + stop() doesn't leak intervals
 * - subsystem interface compliance
 */
import { describe, expect, it, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { DekArchiveScheduler } from "../../../src/daemon/dek-archive-scheduler.js";
import { KeyStore } from "../../../src/keys/store.js";

const WS = "tenant-aaaa-1111";

function mkStore(): KeyStore {
  return new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
}

const origEnv = process.env.WOTW_DEK_OVERLAP_HOURS;
afterEach(() => {
  if (origEnv === undefined) delete process.env.WOTW_DEK_OVERLAP_HOURS;
  else process.env.WOTW_DEK_OVERLAP_HOURS = origEnv;
});

describe("DekArchiveScheduler.runOnce", () => {
  it("archives rotating DEKs past the overlap window", async () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(1);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
  });

  it("leaves rotating DEKs inside the overlap window alone", async () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS); // rotated_at = now
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(0);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("rotating");
  });

  it("uses injected `now` for clock fast-forward in tests", async () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS); // rotated_at = real now
    // Inject a `now` that's 48h in the future — runOnce should treat
    // the rotating DEK as past the 24h overlap.
    const fakeFuture = new Date(Date.now() + 48 * 3600 * 1000).toISOString();
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24,
      now: () => fakeFuture,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(1);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
  });

  it("idempotent across re-runs — second tick is a no-op", async () => {
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24,
    });
    const first = await scheduler.runOnce();
    const second = await scheduler.runOnce();
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it("getLastResult exposes the most recent tick", async () => {
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24,
    });
    await scheduler.runOnce();
    const last = scheduler.getLastResult();
    expect(last).not.toBeNull();
    expect(last!.archived).toBe(1);
    expect(last!.archivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("DekArchiveScheduler overlap resolution", () => {
  it("opts.overlapHours wins over env", async () => {
    process.env.WOTW_DEK_OVERLAP_HOURS = "100";
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      overlapHours: 24, // takes precedence over env
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(1); // 50h > 24h → archives
  });

  it("env overrides default when opts.overlapHours is undefined", async () => {
    process.env.WOTW_DEK_OVERLAP_HOURS = "100";
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 50 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(0); // 50h < 100h env override → stays
  });

  it("default 24h applies when neither opts nor env set", async () => {
    delete process.env.WOTW_DEK_OVERLAP_HOURS;
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(1); // 30h > default 24h → archives
  });

  it("rejects malformed env values, falls back to default", async () => {
    process.env.WOTW_DEK_OVERLAP_HOURS = "not-a-number";
    const store = mkStore();
    store.provision(WS);
    const longAgo = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
    });
    const archived = await scheduler.runOnce();
    expect(archived).toBe(1); // malformed env ignored → default 24h → 30h > 24h → archives
  });
});

describe("DekArchiveScheduler subsystem lifecycle", () => {
  it("start() + stop() doesn't keep the event loop alive", async () => {
    const store = mkStore();
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
      tickIntervalHours: 1,
    });
    await scheduler.start();
    expect(scheduler.name).toBe("dek-archive-scheduler");
    await scheduler.stop();
  });

  it("stop() before start() is safe", async () => {
    const store = mkStore();
    const scheduler = new DekArchiveScheduler({
      keyStore: store,
      workspaceId: WS,
    });
    await scheduler.stop();
  });
});

describe("DekArchiveScheduler archived DEK behavior in ProvenanceChain", () => {
  it("after a DEK transitions rotating → archived, ProvenanceChain.active() no longer returns it", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const k2 = store.active(WS)!;
    store.archiveOverlapped(WS, 24 * 3600 * 1000);
    // k1 was rotating, now archived. k2 is still active.
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
    expect(store.active(WS)?.key_id).toBe(k2.key_id);
    // resolveById still returns the archived DEK (so old records still verify)
    expect(store.resolveById(k1.key_id)?.dek.equals(k1.dek)).toBe(true);
  });
});
