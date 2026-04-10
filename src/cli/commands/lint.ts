/**
 * `wotw lint` — run a health check over the wiki: contradictions, orphan
 * pages, stale references, missing cross-refs. Phase 1/5 ships the cheap
 * structural sweep (file count + orphaned-page count surfaced from
 * frontmatter). LLM-powered lint is a later phase.
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
import { readTextOrNullAsync } from "../../utils/fs.js";
import type { WotwConfig } from "../../utils/types.js";
import { parsePage } from "../../wiki/page.js";
import { info, warn } from "../output.js";

interface LintOptions {
  fix?: boolean;
}

/**
 * Structured result of a single lint pass. `issueCount` is a conservative
 * summary — today it equals `orphanedPages`, but future sub-lints add to
 * it so the scheduler can decide WARN vs INFO without re-parsing text.
 */
export interface LintResult {
  wikiRoot: string;
  totalPages: number;
  orphanedPages: number;
  issueCount: number;
  /** True if the wiki directory did not exist at all. */
  missingWikiDir: boolean;
}

/**
 * Attach the `lint` subcommand.
 */
export function registerLintCommand(program: Command): void {
  program
    .command("lint")
    .description("Run health checks over the wiki (contradictions, orphans, stale refs)")
    .option("--fix", "Attempt to auto-fix lint issues")
    .action(async (opts: LintOptions) => {
      await runLint(opts);
    });
}

/**
 * CLI entry point. Loads config, runs a lint pass, and prints a summary.
 */
export async function runLint(_opts: LintOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const result = await runLintPass(config);

  if (result.missingWikiDir) {
    warn(`No wiki directory at ${join(result.wikiRoot, "wiki")}. Run 'wotw init' first.`);
    return;
  }

  info(`Structural sweep: found ${result.totalPages} wiki pages.`);
  if (result.orphanedPages > 0) {
    warn(`${result.orphanedPages} orphaned page(s) (source deleted but page retained).`);
  } else {
    info("No orphaned pages.");
  }
  info("LLM-powered lint (contradictions, stale refs) lands in a later phase.");
}

/**
 * Execute the structural sweep portion of lint without touching stdout.
 * Returns a {@link LintResult} the caller can log / serialize / trigger
 * alerts on. This is the function the scheduler subsystem invokes.
 */
export async function runLintPass(config: WotwConfig): Promise<LintResult> {
  const wikiRoot = config.wiki_root;
  const wikiDir = join(wikiRoot, "wiki");
  if (!existsSync(wikiDir)) {
    return {
      wikiRoot,
      totalPages: 0,
      orphanedPages: 0,
      issueCount: 0,
      missingWikiDir: true,
    };
  }

  const files = walkMarkdown(wikiDir);
  let orphanedPages = 0;
  for (const file of files) {
    const raw = await readTextOrNullAsync(file);
    if (raw === null) continue;
    const page = parsePage(file, raw);
    if (page.frontmatter.status === "orphaned") orphanedPages += 1;
  }

  return {
    wikiRoot,
    totalPages: files.length,
    orphanedPages,
    issueCount: orphanedPages,
    missingWikiDir: false,
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
