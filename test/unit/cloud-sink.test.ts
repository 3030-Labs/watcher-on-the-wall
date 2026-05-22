/**
 * Unit tests for CloudProvenanceSink — fire-and-forget HTTP sink that
 * mirrors provenance records to wotw-cloud's Supabase replica.
 *
 * Tests use a mocked fetch (via opts.fetchImpl override) so they don't
 * touch network. The sink contract: never throws; returns boolean
 * success/failure; logs warnings on non-2xx and on network errors.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CloudProvenanceSink,
  cloudSinkFromEnv,
  type CloudSinkPayload,
} from "../../src/provenance/cloud-sink.js";
import { GENESIS_HASH, sha256Canonical, sha256Hex } from "../../src/provenance/hash.js";
import type { ProvenanceRecord } from "../../src/utils/types.js";

function makeRecord(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  const payload = {
    seq: 1,
    timestamp: "2026-05-21T00:00:00.000Z",
    type: "ingest" as const,
    source_files: ["raw/note.md"],
    source_hashes: [sha256Hex("note")],
    prompt_hash: sha256Hex("prompt"),
    model_id: "claude-sonnet-4-20250514" as const,
    response_hash: sha256Hex("resp"),
    wiki_files_written: ["wiki/concepts/note.md"],
    wiki_file_hashes_after: { "wiki/concepts/note.md": sha256Hex("body") },
    previous_id: null,
    previous_chain_hash: GENESIS_HASH,
  };
  const id = sha256Canonical(payload);
  const chain_hash = sha256Hex(GENESIS_HASH + id);
  return { ...payload, id, chain_hash, ...overrides };
}

describe("CloudProvenanceSink.append", () => {
  it("POSTs to the correct URL with admin-key header + record payload", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const sink = new CloudProvenanceSink({
      wikiId: "wiki-uuid-1",
      apiBaseUrl: "https://example.test",
      adminServiceKey: "test-admin-key",
      fetchImpl,
    });
    const record = makeRecord();

    const ok = await sink.append(record);

    expect(ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://example.test/api/internal/append-provenance");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["x-admin-key"]).toBe("test-admin-key");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(init?.body as string) as CloudSinkPayload;
    expect(body.wiki_id).toBe("wiki-uuid-1");
    expect(body.seq).toBe(record.seq);
    expect(body.record_id).toBe(record.id);
    expect(body.chain_hash).toBe(record.chain_hash);
    expect(body.operation_type).toBe("ingest");
    expect(body.record_json).toEqual(record);
  });

  it("treats 409 conflict as idempotent success", async () => {
    const fetchImpl = vi.fn(async () => new Response("conflict", { status: 409 }));
    const sink = new CloudProvenanceSink({
      wikiId: "w",
      adminServiceKey: "k",
      fetchImpl,
    });
    const ok = await sink.append(makeRecord());
    expect(ok).toBe(true);
  });

  it("returns false on 4xx (non-409) without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const sink = new CloudProvenanceSink({
      wikiId: "w",
      adminServiceKey: "k",
      fetchImpl,
    });
    const ok = await sink.append(makeRecord());
    expect(ok).toBe(false);
  });

  it("returns false on 5xx without throwing", async () => {
    const fetchImpl = vi.fn(async () => new Response("oops", { status: 500 }));
    const sink = new CloudProvenanceSink({
      wikiId: "w",
      adminServiceKey: "k",
      fetchImpl,
    });
    const ok = await sink.append(makeRecord());
    expect(ok).toBe(false);
  });

  it("returns false on network error without throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const sink = new CloudProvenanceSink({
      wikiId: "w",
      adminServiceKey: "k",
      fetchImpl,
    });
    const ok = await sink.append(makeRecord());
    expect(ok).toBe(false);
  });

  it("uses default https://wotw.dev when apiBaseUrl is not provided", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = new CloudProvenanceSink({
      wikiId: "w",
      adminServiceKey: "k",
      fetchImpl,
    });
    await sink.append(makeRecord());
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://wotw.dev/api/internal/append-provenance");
  });
});

describe("cloudSinkFromEnv", () => {
  it("returns null when WOTW_WIKI_ID is missing", () => {
    expect(cloudSinkFromEnv({ ADMIN_SERVICE_KEY: "k" })).toBeNull();
  });

  it("returns null when ADMIN_SERVICE_KEY is missing", () => {
    expect(cloudSinkFromEnv({ WOTW_WIKI_ID: "w" })).toBeNull();
  });

  it("constructs a sink when both required vars are present", () => {
    const sink = cloudSinkFromEnv({
      WOTW_WIKI_ID: "wiki-1",
      ADMIN_SERVICE_KEY: "secret",
    });
    expect(sink).not.toBeNull();
    expect(sink!.wikiId).toBe("wiki-1");
    expect(sink!.apiBaseUrl).toBe("https://wotw.dev");
  });

  it("honors WOTW_API_BASE_URL override", () => {
    const sink = cloudSinkFromEnv({
      WOTW_WIKI_ID: "wiki-1",
      ADMIN_SERVICE_KEY: "secret",
      WOTW_API_BASE_URL: "https://staging.wotw.dev",
    });
    expect(sink!.apiBaseUrl).toBe("https://staging.wotw.dev");
  });
});
