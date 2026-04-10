/**
 * Integration test: spin up a real McpHttpServer on an ephemeral port and
 * exercise it end-to-end via the SDK client transport. Covers:
 *
 *   - /healthz plain HTTP endpoint
 *   - auth failure (401 without bearer token)
 *   - tool invocation success (search, get_stats, list_pages, read_page)
 *   - multi-user mode: per-user TokenStore authentication
 *
 * No LLM calls are made; the query tool (which needs Claude) is not exercised.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpHttpServer } from "../../src/server/index.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage } from "../../src/wiki/page.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import { callMcpTool } from "../../src/cli/commands/lib/mcp-client.js";
import type { WotwConfig } from "../../src/utils/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-mcp-"));
}

async function buildServer(override: (cfg: WotwConfig) => void = () => undefined): Promise<{
  server: McpHttpServer;
  config: WotwConfig;
  store: WikiStore;
  search: WikiSearch;
  root: string;
}> {
  const root = tmpRoot();
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.multi_user.workspaces_dir = join(root, "workspaces");
  cfg.server.host = "127.0.0.1";
  cfg.server.port = 0; // ephemeral
  override(cfg);
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

  // Seed the wiki with a couple of pages.
  const p1 = newPage(
    store.pathFor("concept", "Hash Chains"),
    "Hash Chains",
    "concept",
    "A hash chain is a sequence of records where each commits to the previous via SHA-256.",
    { tags: ["crypto", "integrity"] },
  );
  const p2 = newPage(
    store.pathFor("concept", "Merkle Trees"),
    "Merkle Trees",
    "concept",
    "Merkle trees generalize hash chains into a balanced binary tree.",
    { tags: ["crypto"] },
  );
  await store.writePage(p1);
  await store.writePage(p2);
  search.rebuild([p1, p2]);
  await indexManager.rebuild([p1, p2]);

  const server = new McpHttpServer({
    config,
    store,
    indexManager,
    search,
    costTracker,
    modelRouter,
  });
  await server.start();
  return { server, config, store, search, root };
}

/** Discover the actual listening port by peeking at the node http server. */
function portOf(server: McpHttpServer): number {
  const httpServer = (server as unknown as { httpServer: HttpServer }).httpServer;
  const addr = httpServer.address();
  if (!addr || typeof addr === "string") {
    throw new Error("server not listening on TCP");
  }
  return addr.port;
}

describe("McpHttpServer (single-token mode)", () => {
  let server: McpHttpServer;
  let port: number;

  beforeAll(async () => {
    const rig = await buildServer((cfg) => {
      cfg.server.auth_token = "test-token-abc";
    });
    server = rig.server;
    port = portOf(server);
  });

  afterAll(async () => {
    await server.stop();
  });

  it("serves /healthz without auth", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe("watcher-on-the-wall");
  });

  it("rejects /mcp calls without a bearer token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("answers search tool calls with a valid token", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "search",
      args: { query: "hash" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.type).toBe("text");
    const hits = JSON.parse(result.content[0]!.text) as Array<{ title: string }>;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.title === "Hash Chains")).toBe(true);
  });

  it("returns stats via get_stats", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "get_stats",
      args: {},
    })) as { content: Array<{ type: string; text: string }> };
    const stats = JSON.parse(result.content[0]!.text) as {
      total: number;
      by_category: Record<string, number>;
      indexed_documents: number;
    };
    expect(stats.total).toBe(2);
    expect(stats.by_category.concept).toBe(2);
    expect(stats.indexed_documents).toBe(2);
  });

  it("lists pages via list_pages", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "list_pages",
      args: {},
    })) as { content: Array<{ type: string; text: string }> };
    const paths = JSON.parse(result.content[0]!.text) as string[];
    expect(paths).toHaveLength(2);
    expect(paths.some((p) => p.includes("hash-chains"))).toBe(true);
  });

  it("reads a page via read_page", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "read_page",
      args: { path: "wiki/concepts/hash-chains.md" },
    })) as { content: Array<{ type: string; text: string }> };
    expect(result.content[0]!.text).toContain("Hash Chains");
    expect(result.content[0]!.text).toContain("SHA-256");
  });

  it("rejects read_page paths containing '..'", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "read_page",
      args: { path: "../../etc/passwd" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  // M-SEC-1: resolveWikiPath must use canonical path.resolve / path.relative
  // rather than a substring check on `..`. These tests lock in the three
  // attack shapes the substring check missed.

  it("rejects read_page with a Windows-style absolute drive path", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "read_page",
      args: { path: "C:/etc/passwd" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("rejects read_page with a relative-prefixed traversal path", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "read_page",
      args: { path: "./../../../etc/passwd" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).toBe(true);
  });

  it("accepts a valid nested wiki path", async () => {
    const result = (await callMcpTool({
      host: "127.0.0.1",
      port,
      authToken: "test-token-abc",
      tool: "read_page",
      args: { path: "wiki/concepts/hash-chains.md" },
    })) as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(result.isError).not.toBe(true);
    expect(result.content[0]!.text).toContain("Hash Chains");
  });
});

describe("McpHttpServer (M-SEC-2: no-auth safety rail)", () => {
  it("refuses to start when auth is disabled and host is non-loopback", async () => {
    const root = mkdtempSync(join(tmpdir(), "wotw-no-auth-"));
    const cfg = defaultConfig();
    cfg.wiki_root = root;
    cfg.raw_path = join(root, "raw");
    cfg.cost.track_file = join(root, "cost-log.jsonl");
    cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
    cfg.multi_user.workspaces_dir = join(root, "workspaces");
    cfg.server.host = "0.0.0.0"; // non-loopback
    cfg.server.port = 0;
    cfg.server.auth_token = null; // no single-token
    cfg.multi_user.enabled = false; // no token store
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
    await expect(server.start()).rejects.toThrow(/refusing to start mcp server/i);
  });

  it("starts (with a WARN) when auth is disabled and host is loopback", async () => {
    // Rely on the build helper which already binds to 127.0.0.1 and
    // leaves auth_token=null + multi_user=false by default.
    const rig = await buildServer();
    try {
      const res = await fetch(`http://127.0.0.1:${portOf(rig.server)}/healthz`);
      expect(res.status).toBe(200);
    } finally {
      await rig.server.stop();
    }
  });
});

describe("McpHttpServer (multi-user mode)", () => {
  let server: McpHttpServer;
  let port: number;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    const rig = await buildServer((cfg) => {
      cfg.multi_user.enabled = true;
    });
    server = rig.server;
    port = portOf(server);
    const tokens = server.getTokenStore()!;
    tokenA = tokens.addUser("alice");
    tokenB = tokens.addUser("bob");
  });

  afterAll(async () => {
    await server.stop();
  });

  it("authenticates both alice and bob independently", async () => {
    for (const tok of [tokenA, tokenB]) {
      const result = (await callMcpTool({
        host: "127.0.0.1",
        port,
        authToken: tok,
        tool: "get_stats",
        args: {},
      })) as { content: Array<{ type: string; text: string }> };
      const stats = JSON.parse(result.content[0]!.text) as { total: number };
      expect(stats.total).toBe(2);
    }
  });

  it("rejects an unknown token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wotw_deadbeef",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });

  it("rejects a revoked token", async () => {
    const tokens = server.getTokenStore()!;
    expect(tokens.revokeUser("bob")).toBeGreaterThan(0);
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokenB}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(401);
  });
});
