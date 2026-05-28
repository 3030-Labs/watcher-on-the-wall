/**
 * `wotw reject <filename>` — reject a candidate page and move it to candidates/rejected/.
 *
 * Optionally accepts a `--reason` flag that is stored in the rejected page's
 * frontmatter so the next compile can incorporate the feedback.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { readTextOrNullAsync } from "../../utils/fs.js";
import { parsePage, serializePage } from "../../wiki/page.js";
import { WikiStore } from "../../wiki/store.js";
import { chalk, fail, info, line, success } from "../output.js";

interface RejectOptions {
  reason?: string;
}

export function registerRejectCommand(program: Command): void {
  program
    .command("reject <filename>")
    .description("Reject a candidate page and move it to candidates/rejected/")
    .option("-r, --reason <text>", "Reason for rejection (stored in frontmatter)")
    .action(async (filename: string, opts: RejectOptions) => {
      await runReject(filename, opts);
    });
}

export async function runReject(filename: string, opts: RejectOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const store = new WikiStore({ wikiRoot: config.wiki_root });

  if (!existsSync(store.candidatesDir)) {
    fail("No candidates/ directory. Run 'wotw init' first.");
    process.exitCode = 1;
    return;
  }

  const candidates = store.listCandidates();
  // Accept a leading candidates/ prefix (matches the listing + audit output),
  // same normalization as `wotw approve` (PASS-023 dogfood finding #24).
  const normalized = filename.replace(/^\.\//, "").replace(/^candidates\//, "");
  const target = join(
    store.candidatesDir,
    normalized.endsWith(".md") ? normalized : `${normalized}.md`,
  );

  if (!existsSync(target)) {
    fail(`Candidate not found: ${basename(target)}`);
    line(`  Available: ${candidates.map((c) => basename(c)).join(", ") || "(none)"}`);
    process.exitCode = 1;
    return;
  }

  const raw = await readTextOrNullAsync(target);
  if (raw === null) {
    fail(`Could not read ${basename(target)}.`);
    process.exitCode = 1;
    return;
  }

  // Parse, inject rejection metadata, and write to rejected/.
  const page = parsePage(target, raw);
  page.frontmatter.rejected_at = new Date().toISOString();
  if (opts.reason) {
    page.frontmatter.rejection_note = opts.reason;
  }

  const rejectedPath = join(store.rejectedDir, basename(target));
  page.path = rejectedPath;

  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(store.rejectedDir, { recursive: true });
  writeFileSync(rejectedPath, serializePage(page), "utf8");

  // Remove the original candidate.
  try {
    const { rmSync } = await import("node:fs");
    rmSync(target, { force: true });
  } catch {
    // Best-effort cleanup.
  }

  success(`Rejected: ${basename(target)}`);
  if (opts.reason) {
    line(`  Reason: ${chalk.dim(opts.reason)}`);
  }
  info("Rejection context will be included in the next compile for this topic.");
}
