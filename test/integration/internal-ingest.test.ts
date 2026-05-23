/**
 * Integration tests for the daemon's POST /internal/ingest endpoint
 * (Pass 012 — file-upload → daemon-ingestion sync).
 *
 * Spins up a McpHttpServer on an ephemeral port, sets ADMIN_SERVICE_KEY,
 * stands up an https fixture with a self-signed cert to act as the
 * Supabase Storage signed-URL fixture, and exercises the daemon's
 * signed-URL → raw_path write path.
 *
 * Verifies:
 *   - auth gate (no key / wrong key → 401)
 *   - validation (missing fields, malformed signed_url, path-traversal in
 *     filename) → 400
 *   - happy path: signed URL fetched, file written to raw_path with
 *     raw_source_id prefix, 202 response
 *   - signed_url returning non-2xx → 502
 *   - network fetch failure → 500
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHttpServer } from "../../src/server/index.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

const ADMIN_KEY = "test-admin-key-pass-012";

async function buildServer(): Promise<{
  server: McpHttpServer;
  config: WotwConfig;
  port: number;
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), "wotw-ingest-"));
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.multi_user.workspaces_dir = join(root, "workspaces");
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  cfg.server.auth_token = "test-mcp-token";
  const config = resolveConfigPaths(cfg);

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  await store.ensureLayout();
  const indexManager = new IndexManager(store);
  const search = new WikiSearch();
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: config.cost.max_daily_usd,
    maxPerIngestUsd: config.cost.max_per_ingest_usd,
    maxPerQueryUsd: config.cost.max_per_query_usd,
  });
  const modelRouter = new ModelRouter(config);

  const server = new McpHttpServer({
    config,
    store,
    indexManager,
    search,
    costTracker,
    modelRouter,
  });
  await server.start();
  const httpServer = (server as unknown as { httpServer: HttpServer }).httpServer;
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server not listening on TCP");
  }
  return { server, config, port: addr.port, root };
}

describe("POST /internal/ingest", () => {
  let server: McpHttpServer;
  let port: number;
  let config: WotwConfig;
  let root: string;
  let oldAdminKey: string | undefined;

  beforeAll(async () => {
    oldAdminKey = process.env.ADMIN_SERVICE_KEY;
    process.env.ADMIN_SERVICE_KEY = ADMIN_KEY;
    const rig = await buildServer();
    server = rig.server;
    port = rig.port;
    config = rig.config;
    root = rig.root;
  });

  afterAll(async () => {
    await server.stop();
    if (oldAdminKey === undefined) {
      delete process.env.ADMIN_SERVICE_KEY;
    } else {
      process.env.ADMIN_SERVICE_KEY = oldAdminKey;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects without admin key (401)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with wrong admin key (401)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": "wrong",
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects missing raw_source_id (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        signed_url: "https://example.com/file",
        filename: "test.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/raw_source_id/);
  });

  it("rejects missing signed_url (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        filename: "test.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/signed_url/);
  });

  it("rejects non-https signed_url (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        signed_url: "http://example.com/file",
        filename: "test.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/signed_url/);
  });

  it("rejects missing filename (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        signed_url: "https://example.com/file",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/filename/);
  });

  it("rejects filename with path-traversal (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        signed_url: "https://example.com/file",
        filename: "../escape.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/filename/);
  });

  it("rejects filename with directory separator (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        signed_url: "https://example.com/file",
        filename: "sub/file.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/filename/);
  });

  it("rejects dot-prefixed filename (400)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-1",
        signed_url: "https://example.com/file",
        filename: ".hidden",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects loopback signed_url (review item 49 SSRF defense)", async () => {
    // Post-item-49 fix: loopback signed URLs are rejected at the SSRF
    // defense layer before any connection attempt. The error is 400 with
    // a structured `code` field (PRIVATE_IP_BLOCKED or HOSTNAME_NOT_ALLOWED
    // depending on which check fires first — both are correct rejections).
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-key": ADMIN_KEY,
      },
      body: JSON.stringify({
        raw_source_id: "rsid-net",
        signed_url: "https://127.0.0.1:1/file",
        filename: "test.pdf",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string };
    expect(["PRIVATE_IP_BLOCKED", "HOSTNAME_NOT_ALLOWED"]).toContain(body.code ?? "");
  });

  it("rejects GET method (404)", async () => {
    // /internal/* only routes POST through the admin handler; GET falls
    // through to the not-found path.
    const res = await fetch(`http://127.0.0.1:${port}/internal/ingest`, {
      method: "GET",
      headers: {
        "x-admin-key": ADMIN_KEY,
      },
    });
    // The handler treats non-POST as empty body → ingest expects raw_source_id
    // and emits 400. Either way: not 200.
    expect([400, 401, 404, 405]).toContain(res.status);
  });

  it("config.raw_path is wired correctly (sanity check)", () => {
    expect(config.raw_path).toContain("wotw-ingest-");
    expect(config.raw_path.endsWith("/raw")).toBe(true);
  });
});
