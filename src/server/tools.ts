/**
 * MCP tool registrations. Each tool has a zod input schema and a handler
 * that returns a CallToolResult. Tools are kept small and composable — the
 * heavy work happens in the wiki/search/query layers.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readTextOrNullAsync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import type { WikiStore } from "../wiki/store.js";
import { CATEGORY_DIRS } from "../wiki/store.js";
import type { IndexManager } from "../wiki/index-manager.js";
import type { WikiSearch } from "../wiki/search.js";
import type { QueryEngine } from "./query-engine.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { DeadLetterQueue } from "../ingestion/dead-letter.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import type { CompoundingEngine } from "../compounding/engine.js";
import type { WotwConfig } from "../utils/types.js";

const VALID_CATEGORIES = Object.keys(CATEGORY_DIRS) as Array<keyof typeof CATEGORY_DIRS>;

export interface ToolRegistrationContext {
  config: WotwConfig;
  store: WikiStore;
  indexManager: IndexManager;
  search: WikiSearch;
  queryEngine: QueryEngine;
  costTracker: CostTracker;
  provenance?: ProvenanceChain | null;
  compounding?: CompoundingEngine | null;
  /**
   * Dead-letter sink. Optional because legacy tests don't supply one;
   * when absent `get_stats` reports `failed_batches: null`.
   */
  deadLetter?: DeadLetterQueue | null;
  /** Count of provenance append failures observed during this daemon lifetime. */
  provenanceGapCount?: number;
  /** Optional watcher reference for degradation reporting. */
  watcher?: { isDegraded(): boolean } | null;
}

/**
 * Register every MCP tool on the provided server instance.
 */
export function registerTools(server: McpServer, ctx: ToolRegistrationContext): void {
  const log = getLogger("mcp-tools");

  // --- search ---------------------------------------------------------
  server.registerTool(
    "search",
    {
      title: "Full-text search over the wiki",
      description: "Search the wiki for pages matching a query. Returns ranked hits with snippets.",
      inputSchema: {
        query: z.string().min(1).describe("Search query. Supports fuzzy matching and prefix."),
        limit: z.number().int().min(1).max(100).default(20).optional(),
        domain: z
          .string()
          .optional()
          .describe("Filter results to pages matching this knowledge domain."),
        scope: z
          .string()
          .optional()
          .describe("Filter results to pages matching this project/context scope."),
      },
    },
    async ({ query, limit, domain, scope }) => {
      // Search index health check.
      if (ctx.search.size() === 0 && ctx.store.count() > 0) {
        return errorResult("search index is empty but wiki has pages — rebuild required");
      }
      const filters = domain || scope ? { domain, scope } : undefined;
      const hits = ctx.search.search(query, limit ?? 20, filters);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              hits.map((h) => ({
                title: h.title,
                category: h.category,
                path: ctx.store.relativePath(h.path),
                score: Number(h.score.toFixed(4)),
                snippet: h.snippet,
              })),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- list_pages -----------------------------------------------------
  server.registerTool(
    "list_pages",
    {
      title: "List wiki pages",
      description: "List every wiki page, optionally filtered by category.",
      inputSchema: {
        category: z.enum(VALID_CATEGORIES as [string, ...string[]]).optional(),
      },
    },
    async ({ category }) => {
      const paths = category
        ? (() => {
            const dir = ctx.store.categoryDir(category as keyof typeof CATEGORY_DIRS);
            return ctx.store.listAll().filter((p) => p.startsWith(dir));
          })()
        : ctx.store.listAll();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              paths.map((p) => ctx.store.relativePath(p)),
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- read_page ------------------------------------------------------
  server.registerTool(
    "read_page",
    {
      title: "Read a wiki page by path",
      description:
        "Read a single wiki page by its wiki-relative path (e.g. 'wiki/concepts/foo.md').",
      inputSchema: {
        path: z.string().min(1),
      },
    },
    async ({ path }) => {
      // Paths are interpreted relative to the wiki root so clients can't
      // escape it via absolute paths.
      const abs = resolveWikiPath(ctx, path);
      if (!abs) {
        return errorResult(`path outside wiki root: ${path}`);
      }
      const raw = await readTextOrNullAsync(abs);
      if (raw === null) {
        return errorResult(`page not found: ${path}`);
      }
      return {
        content: [{ type: "text", text: raw }],
      };
    },
  );

  // --- query ----------------------------------------------------------
  server.registerTool(
    "query",
    {
      title: "Answer a question from the wiki",
      description:
        "Answer a natural-language question grounded in the wiki. Returns an answer with inline citations.",
      inputSchema: {
        question: z.string().min(1),
        k: z.number().int().min(1).max(20).default(8).optional(),
        domain: z
          .string()
          .optional()
          .describe("Filter search context to pages matching this knowledge domain."),
        scope: z
          .string()
          .optional()
          .describe("Filter search context to pages matching this project/context scope."),
      },
    },
    async ({ question, k, domain: _domain, scope: _scope }) => {
      log.info({ question }, "mcp query");
      const result = await ctx.queryEngine.answer(question, k ?? 8);
      if (result.skipped) {
        return errorResult(result.skipReason ?? "query skipped");
      }
      return {
        content: [
          { type: "text", text: result.answer },
          {
            type: "text",
            text: JSON.stringify(
              {
                sources: result.sources.map((s) => ctx.store.relativePath(s.path)),
                cost_usd: result.costUsd,
                model: result.model,
                duration_ms: result.durationMs,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- get_index ------------------------------------------------------
  server.registerTool(
    "get_index",
    {
      title: "Get the wiki index",
      description: "Return the current contents of wiki/index.md.",
      inputSchema: {},
    },
    async () => {
      const text = await ctx.indexManager.read();
      if (!text) {
        return { content: [{ type: "text", text: "_index not yet built_" }], isError: true };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // --- get_stats ------------------------------------------------------
  server.registerTool(
    "get_stats",
    {
      title: "Get wiki stats",
      description: "Return counts of wiki pages by category and today's cost.",
      inputSchema: {},
    },
    async () => {
      const counts: Record<string, number> = {};
      for (const cat of VALID_CATEGORIES) {
        counts[cat] = ctx.store.count(cat);
      }
      // Count orphaned pages by walking the full page list once. Cheap
      // — parsing is cached at the file-system level and the frontmatter
      // check short-circuits on non-orphaned pages.
      let orphanedPages = 0;
      for (const p of ctx.store.listAll()) {
        const page = await ctx.store.readPage(p);
        if (page && page.frontmatter.status === "orphaned") orphanedPages += 1;
      }
      const failedBatches = ctx.deadLetter ? await ctx.deadLetter.count() : null;

      // Compute health summary (no LLM calls).
      let healthSummary: {
        avg_score: number;
        pages_below_50: number;
        lowest_scoring_page: string | null;
      } | null = null;
      try {
        const { computeHealthReport } = await import("../wiki/health.js");
        const pages = ctx.store.listAll();
        if (pages.length > 0) {
          const report = await computeHealthReport(ctx.store, ctx.provenance ?? null, ctx.search, {
            config: ctx.config,
          });
          const avg =
            report.scores.length > 0
              ? Math.round(report.scores.reduce((s, sc) => s + sc.score, 0) / report.scores.length)
              : 0;
          const belowFifty = report.scores.filter((s) => s.score < 50);
          const lowest =
            report.scores.length > 0
              ? report.scores.reduce((min, s) => (s.score < min.score ? s : min), report.scores[0]!)
              : null;
          healthSummary = {
            avg_score: avg,
            pages_below_50: belowFifty.length,
            lowest_scoring_page: lowest ? lowest.page : null,
          };
        }
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "health computation failed",
        );
      }

      // Query health metrics.
      let queryHealth: {
        total_queries_7d: number;
        zero_hit_rate_7d: number;
        zero_hit_queries_7d: string[];
      } | null = null;
      try {
        const { computeZeroHitRate } = await import("./query-metrics.js");
        const metrics = computeZeroHitRate(ctx.config.health.query_log_file);
        if (metrics.total_queries > 0) {
          queryHealth = {
            total_queries_7d: metrics.total_queries,
            zero_hit_rate_7d: Number(metrics.zero_hit_rate.toFixed(4)),
            zero_hit_queries_7d: metrics.recent_zero_hit_queries.slice(0, 10),
          };
        }
      } catch (err: unknown) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "query metrics computation failed",
        );
      }

      const stats = {
        total: ctx.store.count(),
        by_category: counts,
        orphaned_pages: orphanedPages,
        cost_today_usd: ctx.costTracker.spentToday(),
        indexed_documents: ctx.search.size(),
        failed_batches: failedBatches,
        dead_letter_configured: ctx.deadLetter !== null && ctx.deadLetter !== undefined,
        provenance_gaps: ctx.provenanceGapCount ?? 0,
        watcher_degraded: ctx.watcher?.isDegraded() ?? false,
        ...(healthSummary ? { health: healthSummary } : {}),
        ...(queryHealth ? { query_health: queryHealth } : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(stats, null, 2) }] };
    },
  );

  // --- related_pages --------------------------------------------------
  server.registerTool(
    "related_pages",
    {
      title: "Find pages related to a given page",
      description: "Return the `related:` frontmatter slugs for a given wiki page.",
      inputSchema: {
        path: z.string().min(1),
      },
    },
    async ({ path }) => {
      const abs = resolveWikiPath(ctx, path);
      if (!abs) return errorResult(`path outside wiki root: ${path}`);
      const page = await ctx.store.readPage(abs);
      if (!page) return errorResult(`page not found: ${path}`);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                title: page.frontmatter.title,
                related: page.frontmatter.related,
                tags: page.frontmatter.tags,
                sources: page.frontmatter.sources,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- get_provenance_log --------------------------------------------
  if (ctx.provenance) {
    const chain = ctx.provenance;
    server.registerTool(
      "get_provenance_log",
      {
        title: "Read recent provenance records",
        description:
          "Return the N most recent cryptographic provenance records. Optionally filter to records that touched a specific wiki page.",
        inputSchema: {
          limit: z.number().int().min(1).max(500).default(20).optional(),
          path: z.string().optional(),
        },
      },
      async ({ limit, path }) => {
        const records = path ? await chain.recordsFor(path) : await chain.readRecent(limit ?? 20);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  total: chain.count(),
                  returned: records.length,
                  records: records.map((r) => ({
                    seq: r.seq,
                    id: r.id.slice(0, 16),
                    timestamp: r.timestamp,
                    type: r.type,
                    model: r.model_id,
                    sources: r.source_files.length,
                    written: r.wiki_files_written.length,
                    cost_usd: r.metadata?.cost_usd ?? null,
                    chain_hash: r.chain_hash.slice(0, 16),
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // --- verify_provenance --------------------------------------------
    server.registerTool(
      "verify_provenance",
      {
        title: "Verify the cryptographic provenance chain",
        description:
          "Walk the entire provenance chain, recomputing every record's id and chain_hash to detect tampering. Returns a verification report.",
        inputSchema: {},
      },
      async () => {
        const result = await chain.verify();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ok: result.ok,
                  total: result.totalRecords,
                  verified: result.verifiedRecords,
                  errors: result.errors.slice(0, 10),
                  head: chain.head(),
                  signature: await chain.signature(),
                },
                null,
                2,
              ),
            },
          ],
          isError: !result.ok,
        };
      },
    );
  }

  // --- synthesize ----------------------------------------------------
  if (ctx.compounding) {
    const compounding = ctx.compounding;
    server.registerTool(
      "synthesize",
      {
        title: "Run a compounding synthesis pass",
        description:
          "Trigger a synthesis pass that finds clusters of related wiki pages and writes higher-level synthesis pages. Budget-gated and idempotent — existing syntheses covering a cluster are skipped.",
        inputSchema: {},
      },
      async () => {
        log.info("mcp synthesize triggered");
        const result = await compounding.synthesize();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  skipped: result.skipped,
                  skip_reason: result.skipReason ?? null,
                  clusters: result.clusters,
                  pages_written: result.pagesWritten,
                  cost_usd: result.costUsd,
                  git_sha: result.gitSha,
                  duration_ms: result.durationMs,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );
  }
}

/**
 * Resolve a wiki-relative path to an absolute path, rejecting any input
 * that would escape the wiki root.
 *
 * **M-SEC-1.** The previous implementation normalized separators to `/`
 * and then did a substring check for `..`. That catches the most obvious
 * `../../etc/passwd` case but misses at least three real-world attacks:
 *
 *   1. A Windows absolute path like `C:/etc/passwd` — the substring
 *      contains no `..` so the old check accepted it and concatenated it
 *      with `wiki_root` to build `/wiki/rootC:/etc/passwd`, which on
 *      Windows resolves to `C:/etc/passwd`.
 *   2. A POSIX absolute path like `/etc/passwd` — the lstrip of leading
 *      slashes turned it into `etc/passwd`, inside the wiki root. That's
 *      "safe" but breaks the principle of least surprise.
 *   3. A path where `..` appears inside a filename (e.g. `..config.md`)
 *      — the substring check would false-reject a legitimate file.
 *
 * The fix is the standard Node.js idiom for containment: `path.resolve`
 * the user input against the wiki root (collapses `..`, resolves
 * absolutes), then `path.relative` the result back against the wiki root
 * and reject if the relative form starts with `..` (escape) or is
 * absolute (different drive on Windows). This is robust on both POSIX
 * and Windows.
 */
function resolveWikiPath(ctx: ToolRegistrationContext, wikiRelative: string): string | null {
  if (typeof wikiRelative !== "string" || wikiRelative.length === 0) return null;
  const wikiRoot = resolve(ctx.config.wiki_root);
  const abs = resolve(wikiRoot, wikiRelative);
  const rel = relative(wikiRoot, abs);
  if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel)) {
    return null;
  }
  return abs;
}

/** Exposed for unit tests — see M-SEC-1 in AUDIT-REPORT.md. */
export { resolveWikiPath as _resolveWikiPathForTests };

function errorResult(message: string): {
  content: { type: "text"; text: string }[];
  isError: boolean;
} {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
