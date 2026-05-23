/**
 * Query engine. Answers natural-language questions against the wiki by:
 *
 *   1. Running a full-text search over the wiki pages (minisearch)
 *   2. Assembling the top-k hits into a grounded context
 *   3. Invoking the query model via the Claude Agent SDK to write a
 *      structured answer with inline citations
 *
 * The engine is used by both the `wotw query` CLI command and the MCP
 * `query` tool. It enforces the per-query budget cap and logs cost.
 */
import { errMsg } from "../utils/errors.js";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { WikiSearch } from "../wiki/search.js";
import { type SearchHit } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256Hex } from "../provenance/hash.js";
import { expandQuery } from "./query-expansion.js";
import { recordQueryOutcome } from "./query-metrics.js";

/** Maximum bytes of page body to inline per hit (clamps prompt size). */
const MAX_PAGE_BODY_BYTES = 16 * 1024;

export interface QueryEngineOptions {
  config: WotwConfig;
  store: WikiStore;
  search: WikiSearch;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  /** Optional provenance chain — if provided, each query appends a record. */
  provenance?: ProvenanceChain | null;
  /**
   * Resolved runtime mode. Defaults to "api" so legacy callers and test rigs
   * keep working without change. When set to "cli" the engine spawns the
   * `claude` binary for every query and logs cost=0 (subscription-covered).
   */
  runtimeMode?: RuntimeMode;
}

export interface QueryResult {
  question: string;
  answer: string;
  sources: { path: string; title: string; score: number }[];
  costUsd: number;
  durationMs: number;
  model: string;
  skipped: boolean;
  skipReason?: string;
}

const DEFAULT_K = 8;

export class QueryEngine {
  private readonly opts: QueryEngineOptions;

  constructor(opts: QueryEngineOptions) {
    this.opts = opts;
  }

  /**
   * Answer a natural-language question using wiki pages as context.
   * `k` controls the number of top hits to include as grounding context.
   */
  async answer(question: string, k: number = DEFAULT_K): Promise<QueryResult> {
    const log = getLogger("query");
    const started = Date.now();
    const runtimeMode: RuntimeMode = this.opts.runtimeMode ?? "api";
    // CLI mode uses a single Sonnet model for everything (subscription-
    // covered). API mode lets the model-router pick a query-tier model.
    const model =
      runtimeMode === "cli"
        ? this.opts.config.execution.cli_model
        : this.opts.modelRouter.modelFor("query");

    // Budget pre-flight — skipped in CLI mode (subscription-covered).
    // Review item 36: pre-fix estimate was 8K input + 2K output; the
    // actual single-pass prompt assembles 8 full pages at 16KB each
    // (= 128KB input, ~32K tokens) — 4× the old estimate. Update to
    // the realistic upper bound + invoke checkOperationBudget so the
    // per-query cap fires too, not just daily-exceeds.
    const estimated =
      runtimeMode === "cli" ? 0 : this.opts.modelRouter.computeCost(model, 32_000, 4_000);
    if (runtimeMode !== "cli") {
      const budgetErr = this.opts.costTracker.checkOperationBudget("query", estimated);
      if (budgetErr) {
        return {
          question,
          answer: "",
          sources: [],
          costUsd: 0,
          durationMs: Date.now() - started,
          model,
          skipped: true,
          skipReason: budgetErr,
        };
      }
    }

    // Query expansion — expand the query into keyword variants via LLM.
    let searchQuery = question;
    let expansionCost = 0;
    try {
      const expansion = await expandQuery(question, {
        config: this.opts.config,
        costTracker: this.opts.costTracker,
        modelRouter: this.opts.modelRouter,
        runtimeMode,
      });
      if (expansion.expanded) {
        searchQuery = expansion.expandedQuery;
        expansionCost = expansion.costUsd;
        log.debug(
          { terms: expansion.expansionTerms.length },
          "query expanded with keyword variants",
        );
      }
    } catch {
      // Expansion failure is non-fatal — fall back to original query.
    }

    // Search index health pre-flight: if the wiki has pages but the
    // search index is empty, something went wrong during rebuild.
    if (this.opts.search.size() === 0 && this.opts.store.count() > 0) {
      recordQueryOutcome(this.opts.config.health.query_log_file, question, 0);
      return {
        question,
        answer: "",
        sources: [],
        costUsd: 0,
        durationMs: Date.now() - started,
        model,
        skipped: true,
        skipReason: "search index is empty but wiki has pages — rebuild required",
      };
    }

    // Retrieve top-k hits
    const hits = this.opts.search.search(searchQuery, k);
    log.info({ question, hits: hits.length, runtimeMode }, "query received");

    // Zero-hit grounding guard: refuse to answer from general knowledge.
    // The wiki's value is grounded answers backed by source material.
    if (hits.length === 0) {
      recordQueryOutcome(this.opts.config.health.query_log_file, question, 0);
      return {
        question,
        answer:
          "No relevant wiki pages found for this query. Try ingesting source material on this topic first.",
        sources: [],
        costUsd: 0,
        durationMs: Date.now() - started,
        model,
        skipped: false,
      };
    }

    // Pre-assemble full page bodies for each hit. This eliminates the
    // need for the model to use the Read tool to fetch page contents
    // mid-conversation — the single-pass completion sees everything it
    // needs up front. Per-page body is clamped to MAX_PAGE_BODY_BYTES
    // (16KB) to bound prompt size; pages exceeding the cap are truncated
    // with a "[truncated]" marker.
    const hitsWithBody = await Promise.all(
      hits.map(async (h) => {
        // SearchHit.path is the absolute path stored by toDoc() in
        // wiki/search.ts (`id: page.path`). Pass it through to readPage.
        let body = "";
        let truncated = false;
        try {
          const page = await this.opts.store.readPage(h.path);
          if (page) {
            if (page.body.length > MAX_PAGE_BODY_BYTES) {
              body = page.body.slice(0, MAX_PAGE_BODY_BYTES);
              truncated = true;
            } else {
              body = page.body;
            }
          } else {
            // readPage returned null — file deleted or unreadable. Fall
            // back to the snippet so the LLM still has some grounding.
            body = h.snippet;
          }
        } catch {
          body = h.snippet;
        }
        return { hit: h, body, truncated };
      }),
    );

    const systemPrompt = buildQuerySystemPrompt();
    const userPrompt = buildQueryUserPrompt(question, hitsWithBody);

    // Single-pass completion: the prompt now contains full page bodies,
    // so no in-call tool use is required. The wrapper dispatches API
    // mode → AnthropicProvider.completeWithUsage, CLI mode → subprocess.
    let answer = "";
    let costUsd = 0;
    try {
      const result = await runtimeAwareComplete(userPrompt, {
        systemPrompt,
        model,
        config: this.opts.config,
        runtimeMode,
      });
      answer = result.text;
      costUsd = result.costUsd + expansionCost;
      // Review item 34: empty / whitespace LLM response must NOT be
      // returned as a successful answer. Treat as skip with explicit
      // reason so the caller surfaces "I don't know" instead of "".
      if (answer.trim().length === 0) {
        this.opts.costTracker.logUsage({ operation: "query", model, costUsd });
        return {
          question,
          answer: "",
          sources: hits.map(mapSourceMeta),
          costUsd,
          durationMs: Date.now() - started,
          model,
          skipped: true,
          skipReason: "LLM returned empty response",
        };
      }
    } catch (err) {
      log.error({ err, question }, "query agent failed");
      return {
        question,
        answer: "",
        sources: hits.map(mapSourceMeta),
        costUsd: 0,
        durationMs: Date.now() - started,
        model,
        skipped: true,
        skipReason: `query error: ${errMsg(err)}`,
      };
    }

    this.opts.costTracker.logUsage({
      operation: "query",
      model,
      costUsd,
    });

    // Record a provenance event so queries are auditable alongside
    // ingestions. Queries don't write files — wiki_files_written is empty
    // and wiki_file_hashes_after stays empty.
    if (this.opts.provenance) {
      try {
        await this.opts.provenance.append({
          type: "query",
          source_files: hits.map((h) => h.path),
          source_hashes: hits.map((h) => sha256Hex(h.snippet ?? "")),
          prompt_hash: sha256Hex(`${systemPrompt}\n\n${userPrompt}`),
          model_id: model,
          response_hash: sha256Hex(answer),
          wiki_files_written: [],
          wiki_file_hashes_after: {},
          metadata: {
            question_hash: sha256Hex(question),
            cost_usd: Number(costUsd.toFixed(6)),
            hit_count: hits.length,
            duration_ms: Date.now() - started,
          },
        });
      } catch (err) {
        log.error({ err }, "failed to append query provenance");
      }
    }

    // Log query outcome for zero-hit monitoring.
    recordQueryOutcome(this.opts.config.health.query_log_file, question, hits.length);

    return {
      question,
      answer,
      sources: hits.map(mapSourceMeta),
      costUsd,
      durationMs: Date.now() - started,
      model,
      skipped: false,
    };
  }
}

function mapSourceMeta(hit: SearchHit): { path: string; title: string; score: number } {
  return { path: hit.path, title: hit.title, score: hit.score };
}

function buildQuerySystemPrompt(): string {
  return `You are the watcher-on-the-wall query agent.
Answer user questions using only the wiki pages provided as context.
Cite sources inline using [title](relative/path.md) markdown links.
If the wiki does not contain the answer, say so honestly — do not invent facts.
Keep answers grounded, concise, and citation-heavy.`;
}

interface HitWithBody {
  hit: SearchHit;
  body: string;
  truncated: boolean;
}

function buildQueryUserPrompt(question: string, hits: HitWithBody[]): string {
  const lines: string[] = [];
  lines.push(`# Question`);
  lines.push("");
  lines.push(question);
  lines.push("");
  lines.push(`# Retrieved wiki pages (${hits.length})`);
  lines.push("");
  if (hits.length === 0) {
    lines.push("_No matching pages found._");
  } else {
    for (const { hit: h, body, truncated } of hits) {
      lines.push(`## ${h.title}  (score ${h.score.toFixed(3)})`);
      lines.push(`path: ${h.path}`);
      lines.push("");
      lines.push(body);
      if (truncated) {
        lines.push("");
        lines.push("_[page body truncated]_");
      }
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("Write an answer in markdown. Cite sources inline as `[title](path)`.");
  return lines.join("\n");
}
