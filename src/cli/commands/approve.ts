/**
 * `wotw approve <filename>` — move a candidate page from candidates/ to wiki/.
 * `wotw approve --all` — approve all candidates at once.
 *
 * On approval, the page is parsed, its category is read from frontmatter,
 * and it is placed into the corresponding wiki/<category>/ directory. The
 * search index is rebuilt and a provenance record is appended.
 */
import type { Command } from "commander";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { loadAllPages } from "../../ingestion/wiki-writer.js";
import { ProvenanceChain } from "../../provenance/chain.js";
import { sha256Hex } from "../../provenance/hash.js";
import { readTextOrNullAsync } from "../../utils/fs.js";
import { parsePage } from "../../wiki/page.js";
import { WikiSearch } from "../../wiki/search.js";
import { WikiStore } from "../../wiki/store.js";
import { IndexManager } from "../../wiki/index-manager.js";
import { commitWikiChanges } from "../../ingestion/git-committer.js";
import { fail, info, line, success } from "../output.js";

interface ApproveOptions {
  all?: boolean;
}

export function registerApproveCommand(program: Command): void {
  program
    .command("approve [filename]")
    .description("Approve a candidate page and move it to wiki/")
    .option("-a, --all", "Approve all pending candidates")
    .action(async (filename: string | undefined, opts: ApproveOptions) => {
      await runApprove(filename, opts);
    });
}

export async function runApprove(
  filename: string | undefined,
  opts: ApproveOptions,
): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const store = new WikiStore({ wikiRoot: config.wiki_root });

  if (!existsSync(store.candidatesDir)) {
    fail("No candidates/ directory. Run 'wotw init' first.");
    process.exitCode = 1;
    return;
  }

  const candidates = store.listCandidates();

  if (opts.all === true) {
    if (candidates.length === 0) {
      info("No pending candidates.");
      return;
    }
    let approved = 0;
    for (const absPath of candidates) {
      const ok = await approveOne(absPath, store, config);
      if (ok) approved++;
    }
    success(`Approved ${approved} candidate(s).`);
    // Rebuild index + search.
    await rebuildAfterApprove(store, config);
    return;
  }

  if (!filename) {
    fail("Specify a filename or use --all.");
    process.exitCode = 1;
    return;
  }

  // Accept all of: `sample-1.md`, `sample-1`, `candidates/sample-1.md`,
  // `./candidates/sample-1.md`. The `wotw candidates` listing and the
  // `wotw audit` output both show paths with a `candidates/` prefix, so a
  // user who copy-pastes one would otherwise hit "Candidate not found"
  // because we'd join candidatesDir + candidates/... (PASS-023 dogfood
  // finding #24). Strip a leading candidates/ segment before joining.
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

  const ok = await approveOne(target, store, config);
  if (ok) {
    success(`Approved: ${basename(target)}`);
    await rebuildAfterApprove(store, config);
  }
}

export async function approveOne(
  absPath: string,
  store: WikiStore,
  config: ReturnType<typeof resolveConfigPaths>,
): Promise<boolean> {
  const raw = await readTextOrNullAsync(absPath);
  if (raw === null) return false;

  const page = parsePage(absPath, raw);
  const destPath = store.pathFor(page.frontmatter.category, page.frontmatter.title);
  page.path = destPath;

  // Check if a newer version of this page already exists in wiki.
  const existing = await store.readPage(destPath);
  if (existing && existing.frontmatter.updated > page.frontmatter.updated) {
    const { getLogger } = await import("../../utils/logger.js");
    getLogger("approve").warn(
      {
        slug: page.frontmatter.title,
        existing: existing.frontmatter.updated,
        candidate: page.frontmatter.updated,
      },
      "candidate is older than current wiki page — skipping to prevent regression",
    );
    return false;
  }

  await store.writePage(page);
  // Remove from candidates.
  try {
    renameSync(absPath, `${absPath}.approved`);
    // Delete the .approved marker — the page is now in wiki/.
    if (existsSync(`${absPath}.approved`)) {
      const { rmSync } = await import("node:fs");
      rmSync(`${absPath}.approved`, { force: true });
    }
  } catch {
    // Best-effort cleanup.
  }

  // Provenance record.
  if (config.provenance.enabled) {
    try {
      // Review item 44: ad-hoc chain construction would race the daemon
      // for seq numbers if both are writing concurrently. The approve
      // CLI is for the daemon-not-running case (interactive review);
      // when the daemon is up, prefer the MCP `approve_candidate` tool.
      // We still construct a chain here for the CLI-only codepath, but
      // (1) thread tenant_id through (item 43) so the record's canonical
      // hash matches what the daemon's verifier expects, (2) compute
      // real hashes for wiki_file_hashes_after, (3) surface errors via
      // a console.warn rather than the pre-fix silent swallow.
      const chain = new ProvenanceChain({
        path: config.provenance.chain_file,
        tenantId:
          config.hosted.enabled && config.hosted.tenant_id ? config.hosted.tenant_id : undefined,
      });
      await chain.init();
      const wikiFileHashesAfter: Record<string, string> = {};
      try {
        const writtenRaw = readFileSync(destPath, "utf8");
        wikiFileHashesAfter[store.relativePath(destPath)] = sha256Hex(writtenRaw);
      } catch {
        // File-read failure here is real but non-fatal for the record;
        // the hash will simply be absent for this entry.
      }
      await chain.append({
        type: "ingest",
        source_files: page.frontmatter.sources,
        source_hashes: page.frontmatter.sources.map(() => "approved"),
        prompt_hash: sha256Hex("approve"),
        model_id: "user",
        response_hash: sha256Hex(raw),
        wiki_files_written: [store.relativePath(destPath)],
        wiki_file_hashes_after: wikiFileHashesAfter,
        metadata: { approved_from: "candidates" },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.warn(`[approve] provenance append failed: ${msg}`);
    }
  }

  return true;
}

async function rebuildAfterApprove(
  store: WikiStore,
  config: ReturnType<typeof resolveConfigPaths>,
): Promise<void> {
  const search = new WikiSearch();
  const allPages = await loadAllPages(store);
  search.rebuild(allPages);
  const indexManager = new IndexManager(store);
  await indexManager.rebuild(allPages);

  // Commit.
  try {
    await commitWikiChanges({
      wikiRoot: config.wiki_root,
      paths: allPages.map((p) => p.path),
      operationId: `approve-${Date.now()}`,
      operation: "ingest",
      metadata: { action: "approve" },
    });
  } catch {
    // Commit failure is non-fatal for CLI.
  }
}
