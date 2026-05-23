/**
 * Vocabulary enrichment — when the zero-hit rate crosses a threshold,
 * automatically add missing keywords to wiki pages so future queries match.
 *
 * For each zero-hit query, the LLM identifies which existing pages should
 * have matched and what key_terms to add to their frontmatter.
 */
import { relative } from "node:path";
import { getLogger } from "../utils/logger.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256Files, sha256Hex } from "../provenance/hash.js";
import { commitWikiChanges } from "../ingestion/git-committer.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import { computeZeroHitRate } from "../server/query-metrics.js";
import type { WikiSearch } from "./search.js";
import type { WikiStore } from "./store.js";
import { loadAllPages } from "../ingestion/wiki-writer.js";
import { parsePage, serializePage } from "./page.js";
import { resolveEditPath } from "../llm/edits.js";
import { readFileSync } from "node:fs";
import { atomicWriteSync } from "../utils/fs.js";

export interface VocabularyEnrichmentOptions {
  config: WotwConfig;
  store: WikiStore;
  search: WikiSearch;
  provenance: ProvenanceChain | null;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  runtimeMode: RuntimeMode;
}

export interface VocabularyEnrichmentResult {
  queriesProcessed: number;
  pagesEnriched: number;
  termsAdded: number;
  costUsd: number;
  skipped: boolean;
  skipReason?: string;
}

/**
 * Run a vocabulary enrichment pass. Checks the zero-hit rate and, if it
 * exceeds the threshold, asks the LLM to suggest key_terms additions
 * for pages that should have matched the zero-hit queries.
 */
export async function runVocabularyEnrichment(
  opts: VocabularyEnrichmentOptions,
): Promise<VocabularyEnrichmentResult> {
  const log = getLogger("vocabulary-enrichment");
  const config = opts.config;

  if (!config.health.enrichment_enabled) {
    return {
      queriesProcessed: 0,
      pagesEnriched: 0,
      termsAdded: 0,
      costUsd: 0,
      skipped: true,
      skipReason: "enrichment disabled",
    };
  }

  const metrics = computeZeroHitRate(config.health.query_log_file);

  if (metrics.zero_hit_rate <= config.health.zero_hit_threshold) {
    return {
      queriesProcessed: 0,
      pagesEnriched: 0,
      termsAdded: 0,
      costUsd: 0,
      skipped: true,
      skipReason: `zero-hit rate ${(metrics.zero_hit_rate * 100).toFixed(0)}% is below threshold ${(config.health.zero_hit_threshold * 100).toFixed(0)}%`,
    };
  }

  log.info(
    { rate: metrics.zero_hit_rate, queries: metrics.total_queries },
    `Zero-hit rate at ${(metrics.zero_hit_rate * 100).toFixed(0)}%. Running vocabulary enrichment.`,
  );

  const zeroHitQueries = metrics.recent_zero_hit_queries;
  const maxFixes = config.health.max_fixes_per_run;
  const queriesToProcess = zeroHitQueries.slice(0, maxFixes);

  // Get all page titles for context.
  const allPages = await loadAllPages(opts.store);
  const pageTitles = allPages
    .map((p) => `${opts.store.relativePath(p.path)}: ${p.frontmatter.title}`)
    .join("\n");

  let totalCost = 0;
  let totalTermsAdded = 0;
  const enrichedPages = new Set<string>();

  const model =
    opts.runtimeMode === "cli" ? config.execution.cli_model : opts.modelRouter.modelFor("lint");

  const allPrompts: string[] = [];
  const allResponses: string[] = [];

  for (const query of queriesToProcess) {
    // Budget pre-flight.
    if (opts.runtimeMode !== "cli") {
      const estimated = opts.modelRouter.computeCost(model, 2_000, 500);
      if (opts.costTracker.wouldExceedDaily(estimated)) {
        log.warn("vocabulary enrichment paused — daily budget exceeded");
        break;
      }
    }

    try {
      const userPrompt = [
        `This query returned no results in our wiki: "${query}"`,
        "",
        "Here are all wiki pages and their titles:",
        pageTitles,
        "",
        "Which pages, if any, should have matched this query? For each matching page, what keywords should be added to its `key_terms` frontmatter so this query would find it in the future?",
        "",
        'Respond in JSON: { "matches": [{ "page": "relative/path.md", "add_terms": ["term1", "term2"] }] } or { "matches": [] } if no pages are relevant.',
      ].join("\n");

      const result = await runtimeAwareComplete(userPrompt, {
        systemPrompt:
          "You are a vocabulary enrichment assistant. Analyze which wiki pages should match a query and suggest keywords. Return ONLY valid JSON, no other text.",
        model,
        config,
        runtimeMode: opts.runtimeMode,
      });

      allPrompts.push(query);
      allResponses.push(result.text);

      opts.costTracker.logUsage({
        operation: "heal",
        model,
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
      });
      totalCost += result.costUsd;

      // Parse the LLM response.
      const text = result.text.trim();
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;

      const parsed = JSON.parse(jsonMatch[0]) as {
        matches?: Array<{ page: string; add_terms: string[] }>;
      };
      if (!parsed.matches || !Array.isArray(parsed.matches)) continue;

      // Apply term additions.
      for (const match of parsed.matches) {
        if (!match.page || !Array.isArray(match.add_terms) || match.add_terms.length === 0)
          continue;

        // Review item 35: prompt-injection surface — the LLM emits the
        // `match.page` field, and vocabulary-enricher loads every page
        // title into the prompt, so an attacker can plant a value here
        // via a malicious source. Reject any path that doesn't resolve
        // inside the wiki root via the same helper used by JSON-edits.
        const absPath = resolveEditPath(config.wiki_root, match.page);
        if (!absPath) {
          log.warn(
            { page: match.page, query },
            "vocabulary: skipping LLM-emitted path that escapes wiki_root",
          );
          continue;
        }
        try {
          const raw = readFileSync(absPath, "utf8");
          const page = parsePage(absPath, raw);
          const existing = new Set(page.frontmatter.key_terms ?? []);
          const newTerms = match.add_terms.filter(
            (t) => typeof t === "string" && t.trim().length > 0 && !existing.has(t),
          );
          if (newTerms.length === 0) continue;

          page.frontmatter.key_terms = [...(page.frontmatter.key_terms ?? []), ...newTerms];
          atomicWriteSync(absPath, serializePage(page));
          enrichedPages.add(match.page);
          totalTermsAdded += newTerms.length;
        } catch {
          // Skip pages that can't be read/written.
        }
      }
    } catch (err) {
      log.warn({ err, query }, "vocabulary enrichment failed for query");
    }
  }

  // Rebuild search index after mutations.
  if (enrichedPages.size > 0) {
    opts.search.rebuild(await loadAllPages(opts.store));

    // Record provenance.
    if (opts.provenance) {
      const writtenPaths = [...enrichedPages].map((rel) => `${config.wiki_root}/${rel}`);
      const hashes = await sha256Files(writtenPaths);
      const wikiFileHashes: Record<string, string> = {};
      for (const abs of writtenPaths) {
        const h = hashes[abs];
        if (h) wikiFileHashes[relative(config.wiki_root, abs)] = h;
      }

      try {
        await opts.provenance.append({
          type: "heal",
          source_files: [],
          source_hashes: [],
          prompt_hash: sha256Hex(allPrompts.join("\n")),
          model_id: model,
          response_hash: sha256Hex(allResponses.join("\n")),
          wiki_files_written: Object.keys(wikiFileHashes),
          wiki_file_hashes_after: wikiFileHashes,
          metadata: {
            heal_kind: "vocabulary-enrichment",
            queries_processed: queriesToProcess.length,
            pages_enriched: enrichedPages.size,
            terms_added: totalTermsAdded,
          },
        });
      } catch (err) {
        log.error({ err }, "failed to append enrichment provenance");
      }
    }

    // Git commit.
    try {
      const paths = [...enrichedPages].map((rel) => `${config.wiki_root}/${rel}`);
      if (opts.provenance) paths.push(opts.provenance.path);
      await commitWikiChanges({
        wikiRoot: config.wiki_root,
        paths: [...new Set(paths)],
        operationId: `vocabulary-enrichment-${Date.now()}`,
        operation: "heal",
        metadata: {
          heal_kind: "vocabulary-enrichment",
          pages_enriched: enrichedPages.size,
          terms_added: totalTermsAdded,
        },
      });
    } catch (err) {
      log.warn({ err }, "vocabulary enrichment commit failed (non-fatal)");
    }
  }

  log.info(
    {
      queriesProcessed: queriesToProcess.length,
      pagesEnriched: enrichedPages.size,
      termsAdded: totalTermsAdded,
    },
    "vocabulary enrichment complete",
  );

  return {
    queriesProcessed: queriesToProcess.length,
    pagesEnriched: enrichedPages.size,
    termsAdded: totalTermsAdded,
    costUsd: totalCost,
    skipped: false,
  };
}
