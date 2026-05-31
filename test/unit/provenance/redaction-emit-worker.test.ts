/**
 * Unit tests for RedactionEmitWorker — drains the SQLite queue and
 * POSTs to wotw-cloud (FEATURE-PASS-011).
 *
 * Covers:
 *   - successful tick transitions pending → sent
 *   - failed POST keeps rows pending + bumps attempts
 *   - exponential backoff on the worker's poll interval
 *   - per-row archive after maxAttempts
 *   - offline-mode (sink=null) graceful disable — no fetch attempt,
 *     queue rows accumulate, no crash
 *   - restart re-drain (worker drains rows enqueued before it started)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RedactionEmitStore,
  type RedactionEventPayload,
} from "../../../src/provenance/redaction-emit-store.js";
import { RedactionSink } from "../../../src/provenance/redaction-sink.js";
import { RedactionEmitWorker } from "../../../src/provenance/redaction-emit-worker.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000003";

function makePayload(overrides: Partial<RedactionEventPayload> = {}): RedactionEventPayload {
  return {
    redacted_at: "2026-05-30T00:00:00.000Z",
    rule_id: "credential_pattern_01",
    source_file_path: "/raw/x.md",
    redaction_byte_count: 8,
    ...overrides,
  };
}

function makeSink(fetchImpl: ReturnType<typeof vi.fn>): RedactionSink {
  return new RedactionSink({
    workspaceId: WORKSPACE_ID,
    apiBaseUrl: "https://example.test",
    sinkSecret: "test-secret",
    fetchImpl,
  });
}

describe("RedactionEmitWorker", () => {
  let store: RedactionEmitStore;

  beforeEach(() => {
    store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
  });

  afterEach(async () => {
    store.close();
  });

  it("offline mode (sink=null) is a no-op — no fetch, no crash, queue accumulates", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    store.enqueue(WORKSPACE_ID, makePayload());
    const worker = new RedactionEmitWorker({
      store,
      sink: null,
      baseIntervalMs: 1000,
    });
    await worker.start();
    // Queue rows unchanged — sink was null.
    expect(store.countByStatus().pending).toBe(2);
    expect(store.countByStatus().sent).toBe(0);
    await worker.stop();
  });

  it("successful tick drains pending rows → sent", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    store.enqueue(WORKSPACE_ID, makePayload());
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, inserted: 2 }), { status: 200 }),
    );
    const sink = makeSink(fetchImpl);
    const worker = new RedactionEmitWorker({
      store,
      sink,
      baseIntervalMs: 60_000,
    });
    await worker.tick();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.countByStatus().pending).toBe(0);
    expect(store.countByStatus().sent).toBe(2);
    await worker.stop();
  });

  it("restart re-drain — worker started AFTER rows enqueued still drains them", async () => {
    // Enqueue rows BEFORE worker exists (the restart-resume scenario).
    store.enqueue(WORKSPACE_ID, makePayload({ source_file_path: "/a.md" }));
    store.enqueue(WORKSPACE_ID, makePayload({ source_file_path: "/b.md" }));
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, inserted: 2 }), { status: 200 }),
    );
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 60_000,
    });
    await worker.start(); // start() runs an immediate first-tick drain
    expect(store.countByStatus().sent).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it("failed POST keeps rows pending + bumps attempts", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 60_000,
    });
    await worker.tick();
    expect(store.countByStatus().pending).toBe(1);
    expect(store.countByStatus().sent).toBe(0);
    const row = store.listPending(10)[0];
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("503");
    await worker.stop();
  });

  it("exponential backoff doubles the next-tick interval on consecutive failures", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 100,
      maxIntervalMs: 5_000,
    });
    // Tick 1 — fails. currentIntervalMs should be 200 after this.
    await worker.tick();
    const after1 = (worker as unknown as { currentIntervalMs: number }).currentIntervalMs;
    // Tick 2 — fails. Should be 400.
    await worker.tick();
    const after2 = (worker as unknown as { currentIntervalMs: number }).currentIntervalMs;
    // Tick 3 — fails. Should be 800.
    await worker.tick();
    const after3 = (worker as unknown as { currentIntervalMs: number }).currentIntervalMs;
    expect(after1).toBe(200);
    expect(after2).toBe(400);
    expect(after3).toBe(800);
    await worker.stop();
  });

  it("exponential backoff caps at maxIntervalMs", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 100,
      maxIntervalMs: 500,
    });
    for (let i = 0; i < 20; i++) await worker.tick();
    const final = (worker as unknown as { currentIntervalMs: number }).currentIntervalMs;
    expect(final).toBeLessThanOrEqual(500);
    await worker.stop();
  });

  it("successful tick resets the backoff interval to baseIntervalMs", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    let failNext = true;
    const fetchImpl = vi.fn(async () => {
      if (failNext) {
        failNext = false;
        return new Response("oops", { status: 503 });
      }
      return new Response(JSON.stringify({ ok: true, inserted: 1 }), { status: 200 });
    });
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 100,
    });
    await worker.tick(); // fails → interval = 200
    expect((worker as unknown as { currentIntervalMs: number }).currentIntervalMs).toBe(200);
    await worker.tick(); // succeeds → reset
    expect((worker as unknown as { currentIntervalMs: number }).currentIntervalMs).toBe(100);
    await worker.stop();
  });

  it("archives rows once attempts reach maxAttempts", async () => {
    store.enqueue(WORKSPACE_ID, makePayload());
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 100,
      maxAttempts: 3,
    });
    for (let i = 0; i < 3; i++) await worker.tick();
    expect(store.countByStatus().archived).toBe(1);
    expect(store.countByStatus().pending).toBe(0);
    await worker.stop();
  });

  it("empty queue tick is a no-op (no fetch attempted)", async () => {
    const fetchImpl = vi.fn();
    const worker = new RedactionEmitWorker({
      store,
      sink: makeSink(fetchImpl),
      baseIntervalMs: 60_000,
    });
    await worker.tick();
    expect(fetchImpl).not.toHaveBeenCalled();
    await worker.stop();
  });
});
