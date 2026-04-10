/**
 * `wotw candidates` — list all pending and rejected candidate pages.
 *
 * Shows a quick-glance table of every file sitting in candidates/
 * (pending review) and candidates/rejected/ (already rejected with
 * optional notes).
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { readTextOrNullAsync } from "../../utils/fs.js";
import { parsePage } from "../../wiki/page.js";
import { WikiStore } from "../../wiki/store.js";
import { chalk, fail, info, line } from "../output.js";

interface CandidatesOptions {
  json?: boolean;
}

export function registerCandidatesCommand(program: Command): void {
  program
    .command("candidates")
    .description("List pending and rejected candidate pages")
    .option("--json", "Emit machine-readable JSON")
    .action(async (opts: CandidatesOptions) => {
      await runCandidates(opts);
    });
}

export async function runCandidates(opts: CandidatesOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const store = new WikiStore({ wikiRoot: config.wiki_root });

  if (!existsSync(store.candidatesDir)) {
    fail("No candidates/ directory. Run 'wotw init' first.");
    process.exitCode = 1;
    return;
  }

  const pending = store.listCandidates();
  const rejected = store.listRejected();

  if (pending.length === 0 && rejected.length === 0) {
    info("No candidates (pending or rejected).");
    return;
  }

  if (opts.json === true) {
    const entries: Array<{
      file: string;
      status: "pending" | "rejected";
      title?: string;
      category?: string;
      rejected_at?: string;
      rejection_note?: string;
    }> = [];

    for (const absPath of pending) {
      const raw = await readTextOrNullAsync(absPath);
      if (!raw) continue;
      const page = parsePage(absPath, raw);
      entries.push({
        file: basename(absPath),
        status: "pending",
        title: page.frontmatter.title,
        category: page.frontmatter.category,
      });
    }

    for (const absPath of rejected) {
      const raw = await readTextOrNullAsync(absPath);
      if (!raw) continue;
      const page = parsePage(absPath, raw);
      entries.push({
        file: basename(absPath),
        status: "rejected",
        title: page.frontmatter.title,
        category: page.frontmatter.category,
        rejected_at: page.frontmatter.rejected_at,
        rejection_note: page.frontmatter.rejection_note,
      });
    }

    line(JSON.stringify(entries, null, 2));
    return;
  }

  // Human-readable output.
  if (pending.length > 0) {
    info(`${pending.length} pending candidate(s):`);
    line("");
    for (const absPath of pending) {
      const raw = await readTextOrNullAsync(absPath);
      if (!raw) continue;
      const page = parsePage(absPath, raw);
      const name = basename(absPath);
      const cat = chalk.cyan(`[${page.frontmatter.category}]`);
      line(`  ${name}  ${page.frontmatter.title}  ${cat}`);
    }
    line("");
  }

  if (rejected.length > 0) {
    info(`${rejected.length} rejected candidate(s):`);
    line("");
    for (const absPath of rejected) {
      const raw = await readTextOrNullAsync(absPath);
      if (!raw) continue;
      const page = parsePage(absPath, raw);
      const name = basename(absPath);
      const cat = chalk.cyan(`[${page.frontmatter.category}]`);
      const note = page.frontmatter.rejection_note
        ? chalk.dim(` — ${page.frontmatter.rejection_note}`)
        : "";
      line(`  ${name}  ${page.frontmatter.title}  ${cat}${note}`);
    }
    line("");
  }
}
