/**
 * Unit tests for RedactionEmitStore — SQLite-backed durable queue for
 * outbound redaction events (FEATURE-PASS-011).
 *
 * Covers gate-required scenarios:
 *   - queue write-before-emit ordering (enqueue returns event_id BEFORE
 *     any worker tick observes it)
 *   - restart re-drain (close + reopen + listPending preserves rows)
 *   - idempotent replay no-op (event_id PRIMARY KEY ensures uniqueness;
 *     markSent on a sent row is a no-op)
 *   - markFailed + archiveExhausted lifecycle
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  RedactionEmitStore,
  type RedactionEventPayload,
} from "../../../src/provenance/redaction-emit-store.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000001";

function makePayload(overrides: Partial<RedactionEventPayload> = {}): RedactionEventPayload {
  return {
    redacted_at: "2026-05-30T00:00:00.000Z",
    rule_id: "credential_pattern_01",
    source_file_path: "/raw/note.md",
    redaction_byte_count: 20,
    ...overrides,
  };
}

describe("RedactionEmitStore (in-memory)", () => {
  let store: RedactionEmitStore;

  beforeEach(() => {
    store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
  });

  afterEach(() => {
    store.close();
  });

  it("initializes with schema version 1", () => {
    expect(store.schemaVersion()).toBe(1);
  });

  it("enqueue writes a pending row + returns the event_id", () => {
    const id = store.enqueue(WORKSPACE_ID, makePayload());
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const counts = store.countByStatus();
    expect(counts.pending).toBe(1);
    expect(counts.sent).toBe(0);
    expect(counts.archived).toBe(0);
  });

  it("listPending returns rows in creation order, oldest-first", () => {
    const id1 = store.enqueue(
      WORKSPACE_ID,
      makePayload({ source_file_path: "/a" }),
      "2026-05-30T00:00:00.000Z",
    );
    const id2 = store.enqueue(
      WORKSPACE_ID,
      makePayload({ source_file_path: "/b" }),
      "2026-05-30T00:00:01.000Z",
    );
    const id3 = store.enqueue(
      WORKSPACE_ID,
      makePayload({ source_file_path: "/c" }),
      "2026-05-30T00:00:02.000Z",
    );
    const pending = store.listPending(10);
    expect(pending.map((r) => r.event_id)).toEqual([id1, id2, id3]);
    expect(pending[0].payload.source_file_path).toBe("/a");
  });

  it("listPending respects the limit", () => {
    for (let i = 0; i < 5; i++) {
      store.enqueue(WORKSPACE_ID, makePayload(), `2026-05-30T00:00:0${i}.000Z`);
    }
    expect(store.listPending(2)).toHaveLength(2);
    expect(store.listPending(10)).toHaveLength(5);
  });

  it("markSent atomically transitions pending → sent", () => {
    const id1 = store.enqueue(WORKSPACE_ID, makePayload());
    const id2 = store.enqueue(WORKSPACE_ID, makePayload());
    const changes = store.markSent([id1, id2]);
    expect(changes).toBe(2);
    const counts = store.countByStatus();
    expect(counts.pending).toBe(0);
    expect(counts.sent).toBe(2);
  });

  it("markSent on already-sent rows is a no-op (idempotent replay)", () => {
    const id = store.enqueue(WORKSPACE_ID, makePayload());
    expect(store.markSent([id])).toBe(1);
    // Same call again — daemon-side restart-mid-batch replay should not
    // double-process. The row stays 'sent', no state change.
    expect(store.markSent([id])).toBe(0);
    expect(store.countByStatus().sent).toBe(1);
  });

  it("markFailed increments attempts + records last_error", () => {
    const id = store.enqueue(WORKSPACE_ID, makePayload());
    store.markFailed([id], "status=500 body=Internal Server Error");
    store.markFailed([id], "network: ECONNREFUSED");
    const pending = store.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].attempts).toBe(2);
    expect(pending[0].last_error).toContain("ECONNREFUSED");
    // Status stays 'pending' — failures don't transition out until archive
    expect(pending[0].status).toBe("pending");
  });

  it("archiveExhausted moves rows past maxAttempts to 'archived'", () => {
    const id = store.enqueue(WORKSPACE_ID, makePayload());
    for (let i = 0; i < 5; i++) {
      store.markFailed([id], `attempt ${i}`);
    }
    const archived = store.archiveExhausted(5);
    expect(archived).toEqual([id]);
    expect(store.countByStatus().archived).toBe(1);
    expect(store.countByStatus().pending).toBe(0);
    // Re-running is idempotent — already archived rows don't re-transition.
    expect(store.archiveExhausted(5)).toEqual([]);
  });

  it("event_id PRIMARY KEY prevents duplicate inserts (uniqueness)", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(store.enqueue(WORKSPACE_ID, makePayload()));
    }
    expect(ids.size).toBe(100);
  });
});

describe("RedactionEmitStore (file-backed, restart re-drain)", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wotw-redaction-emit-"));
    path = join(dir, "redaction-emit.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("survives close + reopen with pending rows intact", () => {
    const first = new RedactionEmitStore({ path });
    const id1 = first.enqueue(
      WORKSPACE_ID,
      makePayload({ source_file_path: "/a.md" }),
      "2026-05-30T00:00:00.000Z",
    );
    const id2 = first.enqueue(
      WORKSPACE_ID,
      makePayload({ source_file_path: "/b.md" }),
      "2026-05-30T00:00:01.000Z",
    );
    expect(first.countByStatus().pending).toBe(2);
    first.close();

    // Reopen — simulates daemon restart.
    const second = new RedactionEmitStore({ path });
    const pending = second.listPending(10);
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.event_id)).toEqual([id1, id2]);
    expect(pending[0].payload.source_file_path).toBe("/a.md");
    expect(pending[1].payload.source_file_path).toBe("/b.md");
    second.close();
  });

  it("status='sent' rows survive restart too (never deleted)", () => {
    const first = new RedactionEmitStore({ path });
    const id = first.enqueue(WORKSPACE_ID, makePayload());
    first.markSent([id]);
    first.close();

    const second = new RedactionEmitStore({ path });
    expect(second.countByStatus().sent).toBe(1);
    expect(second.countByStatus().pending).toBe(0);
    // Re-drain attempts return empty — sent rows aren't re-queued.
    expect(second.listPending(10)).toEqual([]);
    second.close();
  });
});
