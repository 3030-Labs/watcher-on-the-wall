/**
 * Integration tests for the daemon's GET /internal/verify endpoint
 * (G5 closure, Pass 018, v0.8.2).
 *
 * Verifies:
 *   - auth gate (no key / wrong key → 401)
 *   - 200 with ok:true on a clean chain (incl. records signed by KeyStore)
 *   - 200 with ok:false + errors when the chain is tampered
 *   - 503 when provenance is disabled
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHttpServer } from "../../src/server/index.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { ProvenanceChain, type ProvenanceAppendInput } from "../../src/provenance/chain.js";
import { KeyStore } from "../../src/keys/store.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import type { ProvenanceRecord, WotwConfig } from "../../src/utils/types.js";

const ADMIN_KEY = "test-admin-key-pass-018-verify";
const WS = "tenant-aaaa-1111";

interface BuildServerRig {
  server: McpHttpServer;
  config: WotwConfig;
  port: number;
  root: string;
  chainPath: string;
  keyStore: KeyStore | null;
}

async function buildServer(opts: { provenanceEnabled: boolean }): Promise<BuildServerRig> {
  const root = mkdtempSync(join(tmpdir(), "wotw-verify-"));
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.provenance.enabled = opts.provenanceEnabled;
  cfg.multi_user.workspaces_dir = join(root, "workspaces");
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0;
  cfg.server.auth_token = "test-mcp-token";
  cfg.hosted.enabled = true;
  cfg.hosted.tenant_id = WS;
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

  let provenance: ProvenanceChain | null = null;
  let keyStore: KeyStore | null = null;
  if (opts.provenanceEnabled) {
    keyStore = new KeyStore({
      path: join(root, ".wotw", "keys.db"),
      kek: randomBytes(32),
    });
    keyStore.provision(WS);
    provenance = new ProvenanceChain({
      path: config.provenance.chain_file,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await provenance.init();
  }

  const server = new McpHttpServer({
    config,
    store,
    indexManager,
    search,
    costTracker,
    modelRouter,
    provenance,
  });
  await server.start();
  const httpServer = (server as unknown as { httpServer: HttpServer }).httpServer;
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server not listening on TCP");
  }
  return {
    server,
    config,
    port: addr.port,
    root,
    chainPath: config.provenance.chain_file,
    keyStore,
  };
}

function makeInput(): ProvenanceAppendInput {
  return {
    type: "ingest",
    source_files: ["raw/note.md"],
    source_hashes: ["abc"],
    prompt_hash: "deadbeef",
    model_id: "claude-haiku-4-5",
    response_hash: "cafebabe",
    wiki_files_written: ["wiki/concepts/foo.md"],
    wiki_file_hashes_after: { "wiki/concepts/foo.md": "feed" },
  };
}

describe("GET /internal/verify (with G5 KeyStore)", () => {
  let server: McpHttpServer;
  let port: number;
  let root: string;
  let chainPath: string;
  let keyStore: KeyStore | null;
  let oldAdminKey: string | undefined;

  beforeAll(async () => {
    oldAdminKey = process.env.WOTW_INTERNAL_ADMIN_KEY;
    process.env.WOTW_INTERNAL_ADMIN_KEY = ADMIN_KEY;
    const rig = await buildServer({ provenanceEnabled: true });
    server = rig.server;
    port = rig.port;
    root = rig.root;
    chainPath = rig.chainPath;
    keyStore = rig.keyStore;
    // Append some records via the chain (need to grab from server opts).
    // Easier: reach in and create a new chain handle to the same path.
    const chain = new ProvenanceChain({
      path: chainPath,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());
    await chain.append({ ...makeInput(), type: "query" });
  });

  afterAll(async () => {
    await server.stop();
    if (oldAdminKey === undefined) {
      delete process.env.WOTW_INTERNAL_ADMIN_KEY;
    } else {
      process.env.WOTW_INTERNAL_ADMIN_KEY = oldAdminKey;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("rejects without admin key (401)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("rejects with wrong admin key (401)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": "wrong-key" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 ok:true on a clean chain", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ tenant_id: WS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      total_records: number;
      verified_records: number;
      errors: unknown[];
      duration_ms: number;
    };
    expect(body.ok).toBe(true);
    expect(body.total_records).toBe(2);
    expect(body.verified_records).toBe(2);
    expect(body.errors).toEqual([]);
    expect(body.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it("returns 200 ok:false with errors when the chain is tampered", async () => {
    // Read the chain, tamper a record's hmac, write it back.
    const lines = readFileSync(chainPath, "utf8").trim().split("\n");
    const r = JSON.parse(lines[0]!) as ProvenanceRecord;
    r.hmac = "0".repeat(64);
    writeFileSync(chainPath, `${JSON.stringify(r)}\n${lines.slice(1).join("\n")}\n`);

    const res = await fetch(`http://127.0.0.1:${port}/internal/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ tenant_id: WS }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      errors: { reason: string }[];
    };
    expect(body.ok).toBe(false);
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.some((e) => /hmac/i.test(e.reason))).toBe(true);
  });
});

describe("GET /internal/verify (provenance disabled)", () => {
  let server: McpHttpServer;
  let port: number;
  let root: string;
  let oldAdminKey: string | undefined;

  beforeAll(async () => {
    oldAdminKey = process.env.WOTW_INTERNAL_ADMIN_KEY;
    process.env.WOTW_INTERNAL_ADMIN_KEY = ADMIN_KEY;
    const rig = await buildServer({ provenanceEnabled: false });
    server = rig.server;
    port = rig.port;
    root = rig.root;
  });

  afterAll(async () => {
    await server.stop();
    if (oldAdminKey === undefined) {
      delete process.env.WOTW_INTERNAL_ADMIN_KEY;
    } else {
      process.env.WOTW_INTERNAL_ADMIN_KEY = oldAdminKey;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("returns 503 when provenance is disabled", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/internal/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-admin-key": ADMIN_KEY },
      body: JSON.stringify({ tenant_id: WS }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("provenance_disabled");
  });
});
