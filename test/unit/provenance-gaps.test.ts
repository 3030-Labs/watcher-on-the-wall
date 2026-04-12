/**
 * Regression test for HIGH-2: Provenance gap counter.
 *
 * Verifies that `get_stats` in `registerTools` includes the `provenance_gaps`
 * field in its response, and that the value reflects `ctx.provenanceGapCount`.
 *
 * We exercise this by creating a real McpServer, registering tools against a
 * minimal ToolRegistrationContext, then calling the tool handler directly.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools, type ToolRegistrationContext } from "../../src/server/tools.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { QueryEngine } from "../../src/server/query-engine.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import { VERSION } from "../../src/utils/version.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-prov-gap-"));
}

function buildContext(overrides: Partial<ToolRegistrationContext> = {}): {
  ctx: ToolRegistrationContext;
  root: string;
} {
  const root = tmp();
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, ".wotw", "cost.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  mkdirSync(join(root, ".wotw"), { recursive: true });
  mkdirSync(join(root, "wiki"), { recursive: true });
  const config = resolveConfigPaths(cfg);

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  const search = new WikiSearch();
  const indexManager = new IndexManager(store);
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: config.cost.max_daily_usd,
    maxPerIngestUsd: config.cost.max_per_ingest_usd,
    maxPerQueryUsd: config.cost.max_per_query_usd,
  });
  const modelRouter = new ModelRouter(config);
  const queryEngine = new QueryEngine({
    config,
    store,
    search,
    costTracker,
    modelRouter,
    provenance: null,
  });

  const ctx: ToolRegistrationContext = {
    config,
    store,
    indexManager,
    search,
    queryEngine,
    costTracker,
    provenance: null,
    compounding: null,
    deadLetter: null,
    ...overrides,
  };
  return { ctx, root };
}

/**
 * Build an McpServer with tools registered, then invoke the get_stats handler
 * directly via the server's internal `_registeredTools` object.
 */
async function callGetStats(ctx: ToolRegistrationContext): Promise<Record<string, unknown>> {
  const server = new McpServer(
    { name: "wotw-test", version: VERSION },
    { capabilities: { tools: {} } },
  );
  registerTools(server, ctx);

  // Access the registered tools via the internal `_registeredTools` plain object.
  const registeredTools = (
    server as unknown as {
      _registeredTools: Record<
        string,
        { handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown> }
      >;
    }
  )._registeredTools;

  const tool = registeredTools["get_stats"];
  if (!tool) {
    throw new Error("get_stats tool not registered");
  }

  const result = (await tool.handler({}, {})) as {
    content: Array<{ type: string; text: string }>;
  };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

describe("HIGH-2: provenance_gaps in get_stats", () => {
  it("reports provenance_gaps === 0 when provenanceGapCount is undefined", async () => {
    const { ctx } = buildContext();
    await ctx.store.ensureLayout();
    const stats = await callGetStats(ctx);
    expect(stats).toHaveProperty("provenance_gaps");
    expect(stats.provenance_gaps).toBe(0);
  });

  it("reports provenance_gaps === 0 when provenanceGapCount is explicitly 0", async () => {
    const { ctx } = buildContext({ provenanceGapCount: 0 });
    await ctx.store.ensureLayout();
    const stats = await callGetStats(ctx);
    expect(stats.provenance_gaps).toBe(0);
  });

  it("reports provenance_gaps matching provenanceGapCount when set to a positive value", async () => {
    const { ctx } = buildContext({ provenanceGapCount: 5 });
    await ctx.store.ensureLayout();
    const stats = await callGetStats(ctx);
    expect(stats.provenance_gaps).toBe(5);
  });

  it("reflects mutations to provenanceGapCount between calls", async () => {
    const { ctx } = buildContext({ provenanceGapCount: 1 });
    await ctx.store.ensureLayout();

    const stats1 = await callGetStats(ctx);
    expect(stats1.provenance_gaps).toBe(1);

    // Simulate a provenance append failure incrementing the counter.
    ctx.provenanceGapCount = 3;

    const stats2 = await callGetStats(ctx);
    expect(stats2.provenance_gaps).toBe(3);
  });
});
