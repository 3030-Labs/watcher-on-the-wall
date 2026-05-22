/**
 * Query expansion — expand a user query into keyword variants via LLM
 * so BM25 can find conceptually related pages that use different vocabulary.
 *
 * Gate: `config.query.expand`. Falls back to original query on any failure.
 */
import { getLogger } from "../utils/logger.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";

export interface QueryExpansionOptions {
  config: WotwConfig;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  runtimeMode: RuntimeMode;
}

export interface QueryExpansionResult {
  /** The expanded query string (original + variants, OR-combined). */
  expandedQuery: string;
  /** The individual expansion terms returned by the LLM. */
  expansionTerms: string[];
  /** Whether expansion actually ran (false if disabled, budget exceeded, or failed). */
  expanded: boolean;
  /** Cost of the expansion LLM call. */
  costUsd: number;
}

/**
 * Expand a query into keyword variants via a small LLM call.
 * Returns the original query unchanged if expansion is disabled, budget
 * exceeded, or the LLM call fails.
 */
export async function expandQuery(
  originalQuery: string,
  opts: QueryExpansionOptions,
): Promise<QueryExpansionResult> {
  const log = getLogger("query-expansion");
  const notExpanded: QueryExpansionResult = {
    expandedQuery: originalQuery,
    expansionTerms: [],
    expanded: false,
    costUsd: 0,
  };

  if (!opts.config.query.expand) {
    return notExpanded;
  }

  const model =
    opts.runtimeMode === "cli"
      ? opts.config.execution.cli_model
      : opts.modelRouter.modelFor("query");

  // Budget pre-flight — expansion is a small call (~100 in, ~50 out).
  const estimated = opts.runtimeMode === "cli" ? 0 : opts.modelRouter.computeCost(model, 200, 100);
  if (opts.runtimeMode !== "cli" && opts.costTracker.wouldExceedDaily(estimated)) {
    log.debug("skipping query expansion — daily budget exceeded");
    return notExpanded;
  }

  try {
    const result = await runtimeAwareComplete(
      `Expand this search query into keyword variants. Return a JSON array of 5-10 alternative search terms that someone might use to describe the same concept. Include synonyms, related technical terms, and common phrasings. Query: "${originalQuery}". Respond ONLY with a JSON array of strings, no other text.`,
      {
        systemPrompt:
          "You are a search query expansion assistant. Return ONLY a JSON array of strings, no other text.",
        model,
        config: opts.config,
        runtimeMode: opts.runtimeMode,
      },
    );

    opts.costTracker.logUsage({
      operation: "query",
      model,
      costUsd: result.costUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
    });

    // Parse the response as a JSON array of strings.
    const text = result.text.trim();
    // Try to extract a JSON array from the response (it might have markdown fences).
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log.debug({ text }, "query expansion returned non-JSON — falling back");
      return { ...notExpanded, costUsd: result.costUsd };
    }

    const parsed: unknown = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) {
      log.debug("query expansion returned non-array — falling back");
      return { ...notExpanded, costUsd: result.costUsd };
    }

    const terms = parsed.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    if (terms.length === 0) {
      return { ...notExpanded, costUsd: result.costUsd };
    }

    // Combine original query + expansion terms via space (minisearch uses OR by default).
    const expandedQuery = [originalQuery, ...terms].join(" ");
    log.debug({ originalQuery, terms }, "query expanded");

    return {
      expandedQuery,
      expansionTerms: terms,
      expanded: true,
      costUsd: result.costUsd,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "query expansion failed — falling back to original query",
    );
    return notExpanded;
  }
}
