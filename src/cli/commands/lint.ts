/**
 * `wotw lint` — run health checks over the wiki: staleness, duplicates,
 * broken links, orphans, missing backlinks. With `--fix`, auto-heal
 * fixable findings via LLM-powered repair passes.
 *
 * The work is split into a pure {@link runLintPass} function that returns
 * a structured {@link LintResult} and a thin CLI wrapper. The scheduler
 * subsystem (`src/daemon/lint-scheduler.ts`) calls {@link runLintPass}
 * directly so it can log WARN/INFO based on the result without duplicating
 * the sweep logic.
 */
import type { Command } from "commander";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { CostTracker } from "../../ingestion/cost-tracker.js";
import { resolveExecutionMode } from "../../ingestion/execution-mode.js";
import { ModelRouter } from "../../ingestion/model-router.js";
import { ProvenanceChain } from "../../provenance/chain.js";
import { readTextOrNullAsync } from "../../utils/fs.js";
import type { RuntimeMode, WotwConfig } from "../../utils/types.js";
import { healFinding, type HealContext, type HealResult } from "../../wiki/heal-handlers.js";
import { computeHealthReport, type HealthReport } from "../../wiki/health.js";
import { parsePage } from "../../wiki/page.js";
import { WikiSearch } from "../../wiki/search.js";
import { WikiStore } from "../../wiki/store.js";
import { loadAllPages } from "../../ingestion/wiki-writer.js";
import { chalk, info, line, success, warn } from "../output.js";

interface LintOptions {
  fix?: boolean;
  yes?: boolean;
  json?: boolean;
}

/**
 * Structured result of a single lint pass.
 */
export interface LintResult {
  wikiRoot: string;
  totalPages: number;
  orphanedPages: number;
  issueCount: number;
  /** True if the wiki directory did not exist at all. */
  missingWikiDir: boolean;
  /** Full health report (null when wiki dir is missing). */
  healthReport: HealthReport | null;
  /** Results of auto-heal operations (empty when --fix is not used). */
  healResults: HealResult[];
}

/**
 * Attach the `lint` subcommand.
 */
export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Run health checks over the wiki (staleness, duplicates, orphans, broken links)")
    .option("--fix", "Attempt to auto-fix fixable findings via LLM")
    .option("-y, --yes", "Skip confirmation prompt (non-interactive)")
    .option("--json", "Emit machine-readable JSON instead of a summary")
    .action(async (opts: LintOptions) => {
      await runLint(opts);
    });
}

/**
 * CLI entry point. Loads config, runs a lint pass, optionally heals, and
 * prints a summary.
 */
export async function runLint(opts: LintOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const result = await runLintPass(config, opts);

  if (result.missingWikiDir) {
    warn(`No wiki directory at ${join(result.wikiRoot, "wiki")}. Run 'wotw init' first.`);
    return;
  }

  if (opts.json === true && result.healthReport) {
    line(
      JSON.stringify(
        {
          ...result,
          healthReport: result.healthReport,
        },
        null,
        2,
      ),
    );
    return;
  }

  const report = result.healthReport;
  if (!report) {
    info(`Structural sweep: found ${result.totalPages} wiki pages.`);
    return;
  }

  // Print health summary.
  const avgScore =
    report.scores.length > 0
      ? Math.round(report.scores.reduce((s, p) => s + p.score, 0) / report.scores.length)
      : 0;
  const belowFifty = report.scores.filter((s) => s.score < 50).length;

  info(
    `Health: ${report.scores.length} pages, avg score ${avgScore}, ${belowFifty} page(s) below 50`,
  );

  if (result.orphanedPages > 0) {
    warn(`${result.orphanedPages} orphaned page(s) (source deleted but page retained).`);
  }

  if (report.summary.total > 0) {
    info(
      `Findings: ${report.summary.total} total ` +
        `(${chalk.red(String(report.summary.high))} high, ` +
        `${chalk.yellow(String(report.summary.medium))} medium, ` +
        `${String(report.summary.low)} low) — ` +
        `${report.summary.autoFixable} auto-fixable`,
    );
  } else {
    success("No issues found.");
  }

  // Print heal results.
  if (result.healResults.length > 0) {
    const fixed = result.healResults.filter((r) => r.fixed).length;
    const totalCost = result.healResults.reduce((s, r) => s + r.costUsd, 0);
    info(
      `Auto-heal: ${fixed}/${result.healResults.length} findings fixed` +
        (totalCost > 0 ? ` ($${totalCost.toFixed(4)})` : ""),
    );
  }
}

/**
 * Execute a full lint pass. Returns a {@link LintResult} the caller can
 * log / serialize / trigger alerts on. This is the function the scheduler
 * subsystem invokes.
 */
export async function runLintPass(config: WotwConfig, opts?: LintOptions): Promise<LintResult> {
  const wikiRoot = config.wiki_root;
  const wikiDir = join(wikiRoot, "wiki");
  if (!existsSync(wikiDir)) {
    return {
      wikiRoot,
      totalPages: 0,
      orphanedPages: 0,
      issueCount: 0,
      missingWikiDir: true,
      healthReport: null,
      healResults: [],
    };
  }

  // Count pages + orphans.
  const files = walkMarkdown(wikiDir);
  let orphanedPages = 0;
  for (const file of files) {
    const raw = await readTextOrNullAsync(file);
    if (raw === null) continue;
    const page = parsePage(file, raw);
    if (page.frontmatter.status === "orphaned") orphanedPages += 1;
  }

  // Build full health report.
  const store = new WikiStore({ wikiRoot });
  const search = new WikiSearch();
  const allPages = await loadAllPages(store);
  search.rebuild(allPages);

  // Initialize provenance chain for reading.
  let provenance: ProvenanceChain | null = null;
  if (config.provenance.enabled) {
    provenance = new ProvenanceChain({ path: config.provenance.chain_file });
    await provenance.init();
  }

  const report = await computeHealthReport(store, provenance, search, { config });

  const healResults: HealResult[] = [];

  // Auto-heal if requested.
  if (opts?.fix === true) {
    const fixable = report.findings.filter((f) => f.autoFixable);
    if (fixable.length > 0) {
      // Resolve execution mode for heal invocations.
      let runtimeMode: RuntimeMode = "api";
      try {
        const resolved = resolveExecutionMode(config);
        runtimeMode = resolved.mode;
      } catch {
        // No runtime available — backlink repair still works (no LLM).
      }

      const costTracker = new CostTracker({
        trackFile: config.cost.track_file,
        maxDailyUsd: config.cost.max_daily_usd,
        maxPerIngestUsd: config.cost.max_per_ingest_usd,
        maxPerQueryUsd: config.cost.max_per_query_usd,
      });
      const modelRouter = new ModelRouter(config);

      const healCtx: HealContext = {
        config,
        store,
        search,
        provenance,
        costTracker,
        modelRouter,
        runtimeMode,
      };

      const maxFixes = config.health.max_fixes_per_run;
      let fixCount = 0;

      for (const finding of fixable) {
        if (fixCount >= maxFixes) {
          info(`Reached max_fixes_per_run (${maxFixes}), stopping.`);
          break;
        }
        const result = await healFinding(finding, healCtx);
        if (result) {
          healResults.push(result);
          if (result.fixed) fixCount += 1;
        }
      }
    }
  }

  return {
    wikiRoot,
    totalPages: files.length,
    orphanedPages,
    issueCount: report.summary.total,
    missingWikiDir: false,
    healthReport: report,
    healResults,
  };
}

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const s = statSync(full);
      if (s.isDirectory()) walk(full);
      else if (s.isFile() && name.endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}
