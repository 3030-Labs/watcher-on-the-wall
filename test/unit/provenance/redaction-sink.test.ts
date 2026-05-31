/**
 * Unit tests for RedactionSink — PASS-024 /api/internal/redaction-log
 * POST client (FEATURE-PASS-011).
 *
 * Covers:
 *   - auth header (x-sink-key) present + matches secret
 *   - https-only fail-closed
 *   - batch-cap rejection (client-side defensive limit)
 *   - non-2xx returns structured failure, never throws
 *   - empty batch is a no-op success
 */
import { describe, expect, it, vi } from "vitest";
import {
  CLOUD_REDACTION_BATCH_CAP,
  RedactionSink,
  type RedactionSinkEvent,
  redactionSinkFromEnv,
} from "../../../src/provenance/redaction-sink.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000002";

function makeEvent(overrides: Partial<RedactionSinkEvent> = {}): RedactionSinkEvent {
  return {
    event_id: "00000000-0000-4000-8000-deadbeef0001",
    redacted_at: "2026-05-30T00:00:00.000Z",
    rule_id: "credential_pattern_01",
    source_file_path: "/raw/x.md",
    redaction_byte_count: 16,
    ...overrides,
  };
}

describe("RedactionSink.post", () => {
  it("POSTs to /api/internal/redaction-log with x-sink-key header", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, inserted: 1 }), { status: 200 }),
    );
    const sink = new RedactionSink({
      workspaceId: WORKSPACE_ID,
      apiBaseUrl: "https://example.test",
      sinkSecret: "test-sink-secret",
      fetchImpl,
    });
    const result = await sink.post([makeEvent()]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.inserted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/api/internal/redaction-log");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-sink-key"]).toBe("test-sink-secret");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string) as {
      workspace_id: string;
      events: Array<Record<string, unknown>>;
    };
    expect(body.workspace_id).toBe(WORKSPACE_ID);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].rule_id).toBe("credential_pattern_01");
    expect(body.events[0].redaction_byte_count).toBe(16);
    // cloud-PASS-028: event_id now ships in the payload so the cloud's
    // ON CONFLICT (daemon_event_id) DO NOTHING gives end-to-end at-most-
    // once delivery across daemon restarts (F1 resolved).
    expect(body.events[0].event_id).toBe("00000000-0000-4000-8000-deadbeef0001");
  });

  it("returns ok:false structured failure on 5xx without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 503 }));
    const sink = new RedactionSink({
      workspaceId: WORKSPACE_ID,
      apiBaseUrl: "https://example.test",
      sinkSecret: "k",
      fetchImpl,
    });
    const result = await sink.post([makeEvent()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.errorBody).toContain("oops");
    }
  });

  it("returns ok:false on network error without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const sink = new RedactionSink({
      workspaceId: WORKSPACE_ID,
      apiBaseUrl: "https://example.test",
      sinkSecret: "k",
      fetchImpl,
    });
    const result = await sink.post([makeEvent()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(null);
      expect(result.errorBody).toContain("ECONNREFUSED");
    }
  });

  it("refuses to construct with non-https apiBaseUrl (fail-closed)", () => {
    expect(
      () =>
        new RedactionSink({
          workspaceId: WORKSPACE_ID,
          apiBaseUrl: "http://example.test",
          sinkSecret: "k",
        }),
    ).toThrowError(/must be https:\/\//);
  });

  it("empty batch is a no-op success — no fetch call", async () => {
    const fetchImpl = vi.fn();
    const sink = new RedactionSink({
      workspaceId: WORKSPACE_ID,
      apiBaseUrl: "https://example.test",
      sinkSecret: "k",
      fetchImpl,
    });
    const result = await sink.post([]);
    expect(result.ok).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects oversize batches client-side (defense in depth)", async () => {
    const fetchImpl = vi.fn();
    const sink = new RedactionSink({
      workspaceId: WORKSPACE_ID,
      apiBaseUrl: "https://example.test",
      sinkSecret: "k",
      fetchImpl,
    });
    const oversize = Array.from({ length: CLOUD_REDACTION_BATCH_CAP + 1 }, () => makeEvent());
    const result = await sink.post(oversize);
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("redactionSinkFromEnv", () => {
  it("returns null when WOTW_WIKI_ID is missing", () => {
    const sink = redactionSinkFromEnv({
      WOTW_CLOUD_SINK_SECRET: "secret",
    } as NodeJS.ProcessEnv);
    expect(sink).toBeNull();
  });

  it("returns null when WOTW_CLOUD_SINK_SECRET is missing", () => {
    const sink = redactionSinkFromEnv({
      WOTW_WIKI_ID: WORKSPACE_ID,
    } as NodeJS.ProcessEnv);
    expect(sink).toBeNull();
  });

  it("constructs a sink when both env vars are present", () => {
    const sink = redactionSinkFromEnv({
      WOTW_WIKI_ID: WORKSPACE_ID,
      WOTW_CLOUD_SINK_SECRET: "secret",
    } as NodeJS.ProcessEnv);
    expect(sink).not.toBeNull();
    expect(sink?.workspaceId).toBe(WORKSPACE_ID);
    expect(sink?.apiBaseUrl).toBe("https://wotw.dev");
  });

  it("honors WOTW_API_BASE_URL override", () => {
    const sink = redactionSinkFromEnv({
      WOTW_WIKI_ID: WORKSPACE_ID,
      WOTW_CLOUD_SINK_SECRET: "secret",
      WOTW_API_BASE_URL: "https://staging.wotw.dev",
    } as NodeJS.ProcessEnv);
    expect(sink?.apiBaseUrl).toBe("https://staging.wotw.dev");
  });
});
