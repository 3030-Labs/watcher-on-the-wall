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
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import { invokeIngestionAgent } from "../ingestion/llm-invoker.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { WikiSearch } from "../wiki/search.js";
import { type SearchHit } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256Hex } from "../provenance/hash.js";

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
    const estimated =
      runtimeMode === "cli" ? 0 : this.opts.modelRouter.computeCost(model, 8_000, 2_000);
    if (runtimeMode !== "cli" && this.opts.costTracker.wouldExceedDaily(estimated)) {
      return {
        question,
        answer: "",
        sources: [],
        costUsd: 0,
        durationMs: Date.now() - started,
        model,
        skipped: true,
        skipReason: "daily budget exceeded",
      };
    }

    // Retrieve top-k hits
    const hits = this.opts.search.search(question, k);
    log.info({ question, hits: hits.length, runtimeMode }, "query received");

    // Zero-hit grounding guard: refuse to answer from general knowledge.
    // The wiki's value is grounded answers backed by source material.
    if (hits.length === 0) {
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

    const systemPrompt = buildQuerySystemPrompt();
    const userPrompt = buildQueryUserPrompt(question, hits);

    // Invoke agent (single-shot; we allow only Read/Glob/Grep so it can
    // inspect files referenced in the context but never write).
    let answer = "";
    let costUsd = 0;
    try {
      const result = await invokeIngestionAgent({
        cwd: this.opts.config.wiki_root,
        systemPrompt,
        userPrompt,
        model,
        maxTurns: 5,
        allowedTools: ["Read", "Glob", "Grep"],
        runtimeMode,
        cliConfig:
          runtimeMode === "cli"
            ? {
                cliPath: this.opts.config.execution.cli_path,
                cliModel: this.opts.config.execution.cli_model,
              }
            : undefined,
      });
      answer = result.finalText;
      costUsd = result.totalCostUsd;
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
        skipReason: `query error: ${(err as Error).message}`,
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

function buildQueryUserPrompt(question: string, hits: SearchHit[]): string {
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
    for (const h of hits) {
      lines.push(`## ${h.title}  (score ${h.score.toFixed(3)})`);
      lines.push(`path: ${h.path}`);
      lines.push("");
      lines.push(h.snippet);
      lines.push("");
    }
  }
  lines.push("---");
  lines.push("Write an answer in markdown. Cite sources inline as `[title](path)`.");
  return lines.join("\n");
}
