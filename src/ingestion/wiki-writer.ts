/**
 * Wiki writer reconciler. The ingestion agent writes files directly using
 * the Agent SDK's Write/Edit tools, so the bulk of file IO is already done
 * by the time we receive the invoker result. The writer's job is to:
 *
 *   1. Walk the files the agent claims to have written.
 *   2. Parse each one and validate frontmatter.
 *   3. Rewrite pages through WikiStore.writePage so atomic writes +
 *      frontmatter serialization go through a single choke point.
 *   4. Return the parsed WikiPage objects so the caller can update the
 *      index, search, and cross-reference graph.
 *
 * If the agent wrote a page with missing or bad frontmatter, we normalize
 * it in place rather than failing the whole batch — the worst case is the
 * page gets a default category ("concept") and today's date.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import { readTextOrNullAsync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import type { WikiPage } from "../utils/types.js";
import { parsePage } from "../wiki/page.js";
import type { WikiStore } from "../wiki/store.js";

export interface ReconcileResult {
  /** Pages successfully parsed, validated, and atomically rewritten. */
  pages: WikiPage[];
  /** Paths the agent claimed to write but which we could not reconcile. */
  skipped: { path: string; reason: string }[];
}

/**
 * Walk a list of absolute paths, keep only those inside the wiki directory,
 * parse them, normalize frontmatter, and rewrite them through the store.
 */
export async function reconcileWrittenPages(
  store: WikiStore,
  candidatePaths: string[],
): Promise<ReconcileResult> {
  const log = getLogger("wiki-writer");
  const pages: WikiPage[] = [];
  const skipped: ReconcileResult["skipped"] = [];
  const wikiDir = resolve(store.wikiDir);

  for (const p of candidatePaths) {
    const abs = resolve(p);
    const rel = relative(wikiDir, abs);
    // Reject paths that escape the wiki directory. We accept dotfiles
    // (`.gitkeep`, `.tools.yml`, etc.) — the earlier broad `rel.startsWith(".")`
    // check also rejected those legitimate files. The `..` check must only
    // catch "parent" components, not dotfile names like `..config.md`.
    if (
      rel === "" ||
      rel === ".." ||
      rel.startsWith(`..${sep}`) ||
      rel.startsWith("../") ||
      isAbsolute(rel)
    ) {
      skipped.push({ path: abs, reason: "outside wiki directory" });
      continue;
    }
    const raw = await readTextOrNullAsync(abs);
    if (raw === null) {
      skipped.push({ path: abs, reason: "file not found after agent run" });
      continue;
    }
    try {
      const page = parsePage(abs, raw);
      await store.writePage(page);
      pages.push(page);
    } catch (err) {
      log.warn({ err, path: abs }, "failed to parse written page");
      skipped.push({ path: abs, reason: (err as Error).message });
    }
  }

  return { pages, skipped };
}

/**
 * Scan the entire wiki store, parse every page, and return them. Used on
 * daemon startup and whenever we need a full rebuild of the index/search.
 */
export async function loadAllPages(store: WikiStore): Promise<WikiPage[]> {
  const log = getLogger("wiki-writer");
  const pages: WikiPage[] = [];
  for (const abs of store.listAll()) {
    const raw = await readTextOrNullAsync(abs);
    if (raw === null) continue;
    try {
      pages.push(parsePage(abs, raw));
    } catch (err) {
      log.warn({ err, path: abs }, "failed to parse existing page during scan");
    }
  }
  return pages;
}
