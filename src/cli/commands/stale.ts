/**
 * `wotw stale` — surface wiki pages needing review.
 *
 * Wraps the health scoring system from `src/wiki/health.ts`. A page is
 * considered stale when its staleness factor score falls below a threshold
 * derived from the `--since` duration and the config's staleness table.
 *
 * With `--dashboard`, generates a Dataview-compatible dashboard file inside
 * the wiki root (only if the Dataview plugin is detected in the vault).
 */
import type { Command } from "commander";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { loadAllPages } from "../../ingestion/wiki-writer.js";
import { ProvenanceChain } from "../../provenance/chain.js";
import { computeHealthReport, type PageHealthScore } from "../../wiki/health.js";
import { WikiSearch } from "../../wiki/search.js";
import { WikiStore } from "../../wiki/store.js";
import { chalk, info, line, success, warn } from "../output.js";

interface StaleOptions {
  since?: string;
  json?: boolean;
  dashboard?: boolean;
}

interface StaleEntry {
  title: string;
  path: string;
  staleness_score: number;
  overall_score: number;
}

/**
 * Attach the `stale` subcommand.
 */
export function registerStaleCommand(program: Command): void {
  program
    .command("stale")
    .description("List wiki pages needing fresh sources")
    .option("--since <threshold>", "Staleness threshold (e.g. 14d, 2w)", "30d")
    .option("--json", "Emit machine-readable JSON")
    .option("--dashboard", "Generate a Dataview dashboard file")
    .action(async (opts: StaleOptions) => {
      await runStale(opts);
    });
}

/**
 * Parse a duration string like "14d", "2w" into days.
 */
export function parseDuration(input: string): number {
  const match = /^(\d+)(d|w)$/i.exec(input.trim());
  if (!match) {
    throw new Error(`Invalid duration "${input}". Use Nd for days or Nw for weeks.`);
  }
  const value = Number(match[1]);
  const unit = match[2]!.toLowerCase();
  return unit === "w" ? value * 7 : value;
}

/**
 * Convert a duration in days to the staleness score threshold using the
 * config's staleness table. Pages with a staleness score BELOW the
 * returned value are considered stale for that duration.
 */
export function scoreThresholdForDuration(
  days: number,
  thresholds: number[],
  scores: number[],
): number {
  for (let i = 0; i < thresholds.length; i++) {
    if (days <= thresholds[i]!) {
      return scores[i] ?? 100;
    }
  }
  return scores[scores.length - 1] ?? 0;
}

export async function runStale(opts: StaleOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const wikiRoot = config.wiki_root;
  const wikiDir = join(wikiRoot, "wiki");

  if (!existsSync(wikiDir)) {
    warn("No wiki directory found. Run 'wotw init' first.");
    return;
  }

  const store = new WikiStore({ wikiRoot });
  const search = new WikiSearch();
  const allPages = await loadAllPages(store);
  search.rebuild(allPages);

  let chain: ProvenanceChain | null = null;
  if (config.provenance.enabled && existsSync(config.provenance.chain_file)) {
    chain = new ProvenanceChain({ path: config.provenance.chain_file });
    await chain.init();
  }

  const report = await computeHealthReport(store, chain, search, { config });

  const sinceDays = parseDuration(opts.since ?? "30d");
  const cutoffScore = scoreThresholdForDuration(
    sinceDays,
    config.health.staleness_thresholds,
    config.health.staleness_scores,
  );

  // Build a title map for display.
  const titleByPath = new Map<string, string>();
  for (const p of allPages) {
    titleByPath.set(store.relativePath(p.path), p.frontmatter.title);
  }

  const staleEntries: StaleEntry[] = report.scores
    .filter((s: PageHealthScore) => s.factors.staleness < cutoffScore)
    .sort((a: PageHealthScore, b: PageHealthScore) => a.factors.staleness - b.factors.staleness)
    .map((s: PageHealthScore) => ({
      title: titleByPath.get(s.page) ?? s.page,
      path: s.page,
      staleness_score: s.factors.staleness,
      overall_score: s.score,
    }));

  if (opts.json === true) {
    line(JSON.stringify(staleEntries, null, 2));
    return;
  }

  if (staleEntries.length === 0) {
    success("No stale pages found.");
    return;
  }

  info(`${staleEntries.length} stale page(s) (threshold: ${opts.since ?? "30d"}):`);
  line("");
  for (const entry of staleEntries) {
    const score = chalk.yellow(`${entry.staleness_score}`);
    line(`  ${score}  ${entry.title}  ${chalk.dim(entry.path)}`);
  }

  // Dashboard generation.
  if (opts.dashboard === true) {
    generateDashboard(wikiRoot);
  }
}

/** Exported for testing. */
export function generateDashboard(wikiRoot: string): void {
  const dataviewDir = join(wikiRoot, ".obsidian", "plugins", "dataview");
  if (!existsSync(dataviewDir)) {
    info("Dataview plugin not detected — skipping dashboard generation.");
    return;
  }

  const dashboardPath = join(wikiRoot, "wiki", "Stale Dashboard.md");
  if (existsSync(dashboardPath)) {
    info("Stale Dashboard.md already exists — skipping.");
    return;
  }

  const content = `---
title: Stale Pages Dashboard
---

# Stale Pages Dashboard

Pages not confirmed by any source in the last 30 days.

\`\`\`dataview
TABLE last_confirmed, source_count, superseded_by
FROM "wiki"
WHERE last_confirmed < date(today) - dur(30 days)
SORT last_confirmed ASC
\`\`\`
`;

  writeFileSync(dashboardPath, content);
  success("Generated Stale Dashboard.md with Dataview query.");
}
