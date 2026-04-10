/**
 * `wotw search <terms>` — offline full-text search over wiki content.
 *
 * Unlike `wotw query` (which sends a question to the daemon's LLM for
 * RAG-style answering), `wotw search` runs locally using MiniSearch. No
 * running daemon required — it loads the wiki directly from disk.
 *
 * Results include page title, matching snippet, relevance score, and path.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { loadAllPages } from "../../ingestion/wiki-writer.js";
import { WikiSearch } from "../../wiki/search.js";
import { WikiStore } from "../../wiki/store.js";
import { chalk, fail, info, line, warn } from "../output.js";

interface SearchOptions {
  top?: string;
  json?: boolean;
  open?: boolean;
}

/**
 * Attach the `search` subcommand.
 */
export function registerSearchCommand(program: Command): void {
  program
    .command("search <terms...>")
    .description("Full-text search over wiki content (offline, no daemon needed)")
    .option("--top <n>", "Maximum number of results (default 10)", "10")
    .option("--json", "Emit machine-readable JSON")
    .option("--open", "Open the top result in Obsidian")
    .action(async (terms: string[], opts: SearchOptions) => {
      await runSearch(terms.join(" "), opts);
    });
}

export async function runSearch(query: string, opts: SearchOptions): Promise<void> {
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
  const pages = await loadAllPages(store);

  if (pages.length === 0) {
    info("Wiki is empty. Drop files into raw/ and run 'wotw ingest'.");
    return;
  }

  search.rebuild(pages);
  const limit = Math.max(1, Math.min(100, Number(opts.top) || 10));
  const hits = search.search(query, limit);

  if (hits.length === 0) {
    info(`No results for "${query}".`);
    return;
  }

  if (opts.json === true) {
    line(
      JSON.stringify(
        hits.map((h) => ({
          title: h.title,
          category: h.category,
          path: store.relativePath(h.path),
          score: Number(h.score.toFixed(4)),
          snippet: h.snippet,
        })),
        null,
        2,
      ),
    );
    return;
  }

  info(`${hits.length} result(s) for "${query}":`);
  line("");
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const rank = chalk.dim(`${i + 1}.`);
    const score = chalk.cyan(`[${h.score.toFixed(1)}]`);
    const relPath = store.relativePath(h.path);
    line(`  ${rank} ${h.title} ${score}  ${chalk.dim(relPath)}`);
    if (h.snippet) {
      line(`     ${chalk.dim(h.snippet.slice(0, 120))}`);
    }
  }

  if (opts.open === true && hits.length > 0) {
    const topHit = hits[0]!;
    const relPath = store.relativePath(topHit.path);
    try {
      const { openInObsidian } = await import("../lib/vault-detect.js");
      const ok = await openInObsidian(wikiRoot);
      if (!ok) {
        fail(`Could not open ${relPath} in Obsidian.`);
      }
    } catch {
      fail(`Could not open ${relPath} in Obsidian.`);
    }
  }
}
