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
import type { LlmProviderName, WotwConfig } from "../utils/types.js";
import type { ProgressiveCache } from "./progressive-cache.js";
import { queryProgressive, queryExpand } from "./progressive-query.js";
import { estimateQueryCost } from "./cost-estimator.js";
import { defineEntity, relateEntities, citeSources } from "./narrow-query.js";
import { queryFacts, renderFactsMarkdown } from "./fact-query.js";
import type { FactIndex } from "../facts/index-manager.js";
import type { FactStore } from "../facts/store.js";

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
  /**
   * Continuation cache for `query_progressive` / `query_expand`. Shared
   * across MCP requests on the long-lived McpHttpServer instance.
   */
  progressiveCache?: ProgressiveCache | null;
  /**
   * Pass B fact-extraction sidecar. When present, the query_facts MCP
   * tool is registered and the Group A tools (define / relate /
   * cite_sources) prefer fact-layer matches before falling back to
   * page-level retrieval.
   */
  factStore?: FactStore | null;
  factIndex?: FactIndex | null;
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
        // Review item 15: `domain` and `scope` were advertised in the
        // tool schema but destructured into `_domain` / `_scope` and
        // ignored. The schema now reflects only what's implemented;
        // re-add once wiki search supports filter-by-frontmatter.
      },
    },
    async ({ question, k }) => {
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

  // --- query_progressive ----------------------------------------------
  // Feature Pass 005. Smallest-viable-answer-first retrieval. Pure
  // structural over the BM25 hit list — no daemon-side LLM call.
  if (ctx.progressiveCache) {
    const cache = ctx.progressiveCache;
    server.registerTool(
      "query_progressive",
      {
        title: "Progressive wiki retrieval",
        description:
          "Retrieve the smallest viable answer first (tier 0 = top hit's lede paragraph), with a continuation_token to expand to higher tiers as the client LLM signals it needs more context. Pure BM25 retrieval; no daemon-side LLM synthesis. Use with `query_expand` for paged retrieval.",
        inputSchema: {
          question: z.string().min(1),
          max_tokens_initial: z
            .number()
            .int()
            .min(64)
            .max(8192)
            .default(512)
            .optional()
            .describe("Token budget for the initial (tier 0) response."),
          max_tokens_total: z
            .number()
            .int()
            .min(64)
            .max(32768)
            .default(8192)
            .optional()
            .describe("Hard cap on tokens shipped across all expand calls."),
        },
      },
      async ({ question, max_tokens_initial, max_tokens_total }) => {
        log.info({ question }, "mcp query_progressive");
        const result = await queryProgressive(question, {
          store: ctx.store,
          search: ctx.search,
          cache,
          maxTokensInitial: max_tokens_initial,
          maxTokensTotal: max_tokens_total,
        });
        return {
          content: [
            { type: "text", text: result.content },
            {
              type: "text",
              text: JSON.stringify(
                {
                  tier: result.tier,
                  tier_label: result.tier_label,
                  hit_count_delta: result.hit_count_delta,
                  hit_count_total: result.hit_count_total,
                  tokens_delivered: result.tokens_delivered,
                  tokens_shipped_total: result.tokens_shipped_total,
                  has_more: result.has_more,
                  continuation_token: result.continuation_token,
                  next_tier_label: result.next_tier_label,
                  next_tier_estimate_tokens: result.next_tier_estimate_tokens,
                },
                null,
                2,
              ),
            },
          ],
        };
      },
    );

    // --- query_expand --------------------------------------------------
    server.registerTool(
      "query_expand",
      {
        title: "Expand a progressive retrieval to the next tier",
        description:
          "Advance one tier on a prior query_progressive call. Returns ONLY the new content the next tier reveals (snippets / section-ledes / full-bodies). Pass the continuation_token from the previous response.",
        inputSchema: {
          continuation_token: z.string().min(1),
          additional_tokens: z
            .number()
            .int()
            .min(64)
            .max(16384)
            .default(1024)
            .optional()
            .describe("Token budget for this expansion. Bounded by max_tokens_total."),
        },
      },
      async ({ continuation_token, additional_tokens }) => {
        log.info({ continuation_token: continuation_token.slice(0, 8) }, "mcp query_expand");
        const result = await queryExpand(continuation_token, {
          cache,
          additionalTokens: additional_tokens,
        });
        if ("error" in result) {
          return errorResult(result.error);
        }
        return {
          content: [
            { type: "text", text: result.content },
            {
              type: "text",
              text: JSON.stringify(
                {
                  tier: result.tier,
                  tier_label: result.tier_label,
                  hit_count_delta: result.hit_count_delta,
                  hit_count_total: result.hit_count_total,
                  tokens_delivered: result.tokens_delivered,
                  tokens_shipped_total: result.tokens_shipped_total,
                  has_more: result.has_more,
                  continuation_token: result.continuation_token,
                  next_tier_label: result.next_tier_label,
                  next_tier_estimate_tokens: result.next_tier_estimate_tokens,
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

  // --- estimate_query_cost --------------------------------------------
  // Feature Pass 006. Pre-flight token estimate so the client LLM knows
  // what the retrieval payload will cost before committing.
  server.registerTool(
    "estimate_query_cost",
    {
      title: "Estimate retrieval-payload token cost",
      description:
        "Run BM25 retrieval over a candidate question and report the token count of the daemon's resulting retrieval payload, scoped per provider. Use BEFORE calling `query` or `query_progressive` to know what you're committing to. Provider defaults to WOTW_LLM_PROVIDER or the daemon's configured llm.provider; omitting both returns a four-row comparison.",
      inputSchema: {
        question: z.string().min(1),
        provider: z
          .enum(["anthropic", "openai", "gemini", "ollama"])
          .optional()
          .describe("Specific provider to estimate for. Omit to compare all four."),
        model: z
          .string()
          .optional()
          .describe("Model identifier (required for precise Anthropic/Gemini counts)."),
        precise: z
          .boolean()
          .default(false)
          .optional()
          .describe(
            "Use the provider's native tokenizer (network call for Anthropic/Gemini). Default is the 4-char heuristic.",
          ),
        k: z.number().int().min(1).max(20).default(8).optional(),
      },
    },
    async ({ question, provider, model, precise, k }) => {
      log.info({ question, provider, precise }, "mcp estimate_query_cost");
      const result = await estimateQueryCost(question, {
        store: ctx.store,
        search: ctx.search,
        config: ctx.config,
        provider: provider as LlmProviderName | undefined,
        model,
        precise: precise ?? false,
        k,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    },
  );

  // --- define ---------------------------------------------------------
  // Feature Pass 007: structural narrow query — single-paragraph definition.
  server.registerTool(
    "define",
    {
      title: "Get a one-paragraph definition of an entity",
      description:
        "BM25-search for `entity` and return the most relevant single-paragraph definition or page lede. Capped at 256 tokens by default — for full-page reading use `read_page`.",
      inputSchema: {
        entity: z.string().min(1),
        max_tokens: z.number().int().min(32).max(2048).default(256).optional(),
      },
    },
    async ({ entity, max_tokens }) => {
      log.info({ entity }, "mcp define");
      const result = await defineEntity(entity, {
        store: ctx.store,
        search: ctx.search,
        maxTokens: max_tokens,
        factIndex: ctx.factIndex ?? null,
      });
      return {
        content: [
          { type: "text", text: result.definition || `_no definition found for ${entity}_` },
          {
            type: "text",
            text: JSON.stringify(
              {
                entity: result.entity,
                source_page: result.source_page,
                score: result.score,
                tokens: result.tokens,
                no_hits: result.no_hits,
                source_layer: result.source_layer,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- relate ---------------------------------------------------------
  // Feature Pass 007: up to N atomic relationship statements between
  // two anchors. Intersection-based — only pages that appear in BOTH
  // result sets are scanned for sentences.
  server.registerTool(
    "relate",
    {
      title: "Find relationship statements between two entities",
      description:
        "Find sentences in the wiki that contain BOTH `entity_a` and `entity_b`. Returns up to 3 atomic statements by default. Capped at 768 tokens — for broader context use `query_progressive`.",
      inputSchema: {
        entity_a: z.string().min(1),
        entity_b: z.string().min(1),
        max_tokens: z.number().int().min(64).max(4096).default(768).optional(),
        max_statements: z.number().int().min(1).max(10).default(3).optional(),
      },
    },
    async ({ entity_a, entity_b, max_tokens, max_statements }) => {
      log.info({ entity_a, entity_b }, "mcp relate");
      const result = await relateEntities(entity_a, entity_b, {
        store: ctx.store,
        search: ctx.search,
        maxTokens: max_tokens,
        maxStatements: max_statements,
        factIndex: ctx.factIndex ?? null,
      });
      const rendered =
        result.statements.length === 0
          ? `_no relationship statements found between ${entity_a} and ${entity_b}_`
          : result.statements.map((s) => `- ${s.statement} _(${s.source_page})_`).join("\n");
      return {
        content: [
          { type: "text", text: rendered },
          {
            type: "text",
            text: JSON.stringify(
              {
                entity_a: result.entity_a,
                entity_b: result.entity_b,
                statement_count: result.statements.length,
                tokens: result.tokens,
                no_hits: result.no_hits,
                source_layer: result.source_layer,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- cite_sources ---------------------------------------------------
  // Feature Pass 007: provenance citations for a claim.
  server.registerTool(
    "cite_sources",
    {
      title: "Get provenance citations for a claim",
      description:
        "BM25-search for `claim`, then return the provenance records (raw source files + chain hash + timestamp) that produced the matched wiki pages. Capped at 512 tokens by default.",
      inputSchema: {
        claim: z.string().min(1),
        max_tokens: z.number().int().min(64).max(4096).default(512).optional(),
      },
    },
    async ({ claim, max_tokens }) => {
      log.info({ claim }, "mcp cite_sources");
      const result = await citeSources(claim, {
        store: ctx.store,
        search: ctx.search,
        provenance: ctx.provenance ?? null,
        maxTokens: max_tokens,
        factIndex: ctx.factIndex ?? null,
      });
      const rendered =
        result.citations.length === 0
          ? result.provenance_unavailable
            ? "_provenance subsystem is disabled in this daemon_"
            : `_no provenance citations found for: ${claim}_`
          : result.citations
              .map(
                (c) =>
                  `- **${c.title}** (\`${c.wiki_page}\`, ${c.type} @ ${c.timestamp})\n  sources: ${c.source_files.length > 0 ? c.source_files.join(", ") : "_none_"}\n  chain: ${c.chain_hash}`,
              )
              .join("\n");
      return {
        content: [
          { type: "text", text: rendered },
          {
            type: "text",
            text: JSON.stringify(
              {
                claim: result.claim,
                citation_count: result.citations.length,
                tokens: result.tokens,
                no_hits: result.no_hits,
                provenance_unavailable: result.provenance_unavailable,
                source_layer: result.source_layer,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // --- query_facts ----------------------------------------------------
  // Feature Pass 008: structural fact-level retrieval. BM25 over the
  // facts + synthetic-questions index (weighted 0.4 + 0.6). When the
  // fact layer is empty / disabled, the response carries
  // fallback: "page-level" so the client LLM knows to redirect to
  // query_progressive.
  server.registerTool(
    "query_facts",
    {
      title: "Atomic-fact retrieval (Pass B)",
      description:
        'Search the fact-level index (atomic entity/statement pairs + synthetic questions) for the best matching facts. Per Cambridge ALTA + Yanhong Li / TTIC, this gives precise atomic answers at ~10x fewer tokens than page-level retrieval. When the fact layer is disabled / empty, returns fallback:"page-level" so the caller can redirect to `query_progressive`.',
      inputSchema: {
        question: z.string().min(1),
        limit: z.number().int().min(1).max(20).default(5).optional(),
      },
    },
    async ({ question, limit }) => {
      log.info({ question }, "mcp query_facts");
      const result = queryFacts(question, {
        factIndex: ctx.factIndex ?? null,
        factStore: ctx.factStore ?? null,
        limit,
      });
      return {
        content: [
          { type: "text", text: renderFactsMarkdown(result) },
          {
            type: "text",
            text: JSON.stringify(
              {
                question: result.question,
                hit_count: result.hits.length,
                tokens: result.tokens,
                fallback: result.fallback,
                index_size: result.index_size,
                hits: result.hits.map((h) => ({
                  entity: h.fact.entity,
                  statement: h.fact.statement,
                  wiki_page: h.fact.wiki_page_id,
                  score: h.score,
                  matched_via_fact: h.matched_via_fact,
                  matched_via_question: h.matched_via_question,
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
