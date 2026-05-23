/**
 * `wotw facts <subcommand>` — Pass B fact-layer CLI.
 *
 * Today the only subcommand is `reindex`: walk every wiki page, run
 * fact extraction on each, and rebuild the SQLite fact store from
 * scratch. Designed for the "I just enabled fact_extraction on an
 * existing wiki" migration path. Prompts for confirmation when running
 * against a metered provider (since extraction can amplify per-tenant
 * cost), or just runs when the runtime is cost-free (Ollama / Claude
 * Code CLI).
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { loadAllPages } from "../../ingestion/wiki-writer.js";
import { CostTracker } from "../../ingestion/cost-tracker.js";
import { WikiStore } from "../../wiki/store.js";
import { resolveExecutionMode } from "../../ingestion/execution-mode.js";
import { FactStore } from "../../facts/store.js";
import { FactIndex } from "../../facts/index-manager.js";
import { extractFactsFromPage, isExtractionActive } from "../../facts/extractor.js";
import { chalk, fail, info, line, success, warn } from "../output.js";

interface ReindexOptions {
  yes?: boolean;
  json?: boolean;
}

export function registerFactsCommand(program: Command): void {
  const factsCmd = program
    .command("facts")
    .description("Manage the fact-extraction layer (Pass B)");

  factsCmd
    .command("reindex")
    .description("Extract atomic facts + synthetic questions for every wiki page")
    .option("-y, --yes", "Skip confirmation prompts (non-interactive mode)")
    .option("--json", "Emit a JSON summary on completion (CI-friendly)")
    .action(async (opts: ReindexOptions) => {
      await runReindex(opts);
    });
}

async function runReindex(opts: ReindexOptions): Promise<void> {
  const { config: rawConfig } = await loadConfig();
  const config = resolveConfigPaths(rawConfig, process.cwd());
  if (!existsSync(config.wiki_root)) {
    fail(`wiki_root does not exist: ${config.wiki_root}`);
    process.exit(1);
  }

  const resolved = resolveExecutionMode(config);
  const runtimeMode = resolved.mode;
  const active = isExtractionActive(config, runtimeMode);
  if (!active.active) {
    fail(`fact extraction is not active: ${active.reason}`);
    info(
      "Set fact_extraction.enabled=true or fact_extraction.force_enabled=true in wotw.config.yaml to override.",
    );
    process.exit(1);
  }

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  const pages = await loadAllPages(store);
  if (pages.length === 0) {
    warn("no wiki pages to index — nothing to do");
    return;
  }

  // Cost preflight for metered providers (cli + ollama report cost 0).
  if (runtimeMode === "api" && config.llm.provider !== "ollama" && !opts.yes) {
    info(
      `About to extract facts for ${pages.length} page(s) on metered provider ${config.llm.provider}.`,
    );
    info("Re-run with --yes once you have confirmed the cost is acceptable.");
    process.exit(0);
  }

  const factsDbPath = join(config.wiki_root, ".wotw", "facts.db");
  const factStore = new FactStore({ path: factsDbPath });
  const factIndex = new FactIndex();
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: config.cost.max_daily_usd,
    maxPerIngestUsd: config.cost.max_per_ingest_usd,
    maxPerQueryUsd: config.cost.max_per_query_usd,
  });

  line();
  info(`reindexing ${pages.length} page(s) (runtime=${runtimeMode}, reason: ${active.reason})`);
  let totalFacts = 0;
  let totalQuestions = 0;
  let totalCost = 0;
  let failures = 0;
  let pageIdx = 0;

  for (const page of pages) {
    pageIdx += 1;
    const relPath = relative(config.wiki_root, page.path) || page.path;
    process.stdout.write(`[${pageIdx}/${pages.length}] ${chalk.gray(relPath.slice(0, 80))} ... `);
    let extraction;
    try {
      extraction = await extractFactsFromPage({
        config,
        runtimeMode,
        wikiPageId: relPath,
        pageBody: page.body,
        title: page.frontmatter.title,
        costTracker,
      });
    } catch (err) {
      process.stdout.write(chalk.red("err\n"));
      warn(`  ${err instanceof Error ? err.message.slice(0, 200) : "unknown error"} — skipping`);
      failures += 1;
      continue;
    }
    if (!extraction.ran) {
      process.stdout.write(chalk.gray("skip\n"));
      continue;
    }
    if (extraction.facts.length === 0) {
      process.stdout.write(chalk.gray("(empty)\n"));
      continue;
    }
    factStore.supersedeByWikiPage(relPath);
    let pageFacts = 0;
    let pageQuestions = 0;
    for (const f of extraction.facts) {
      try {
        const { id } = factStore.insertFact({
          wiki_page_id: relPath,
          entity: f.entity,
          statement: f.statement,
        });
        const questions = factStore.insertQuestions(id, f.questions);
        const fact = factStore.getFact(id);
        if (fact) factIndex.add(fact, questions);
        pageFacts += 1;
        pageQuestions += questions.length;
      } catch {
        // Hash collision (very rare) — skip.
      }
    }
    totalFacts += pageFacts;
    totalQuestions += pageQuestions;
    totalCost += extraction.costUsd;
    process.stdout.write(
      chalk.green(
        `${pageFacts} facts · ${pageQuestions} questions · $${extraction.costUsd.toFixed(4)}\n`,
      ),
    );
  }

  line();
  success(
    `reindex complete — ${totalFacts} facts, ${totalQuestions} questions across ${pages.length - failures} pages (${failures} failed)`,
  );
  success(`total cost: $${totalCost.toFixed(4)}`);
  factStore.close();

  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pages: pages.length,
          facts: totalFacts,
          questions: totalQuestions,
          failures,
          cost_usd: Number(totalCost.toFixed(6)),
        },
        null,
        2,
      )}\n`,
    );
  }
}
