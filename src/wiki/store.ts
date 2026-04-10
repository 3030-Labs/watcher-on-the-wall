/**
 * Wiki store: three-layer abstraction over the wiki_root directory tree.
 *
 *   raw/         — immutable source files dropped by users (we only read them)
 *   wiki/        — generated markdown pages grouped by category
 *     sources/
 *     concepts/
 *     entities/
 *     comparisons/
 *     syntheses/
 *     queries/
 *
 * The store knows how to list pages, read them, write them atomically,
 * and resolve slugs to category directories. It owns no mutation policy
 * beyond "one file per page, atomic writes, directories created on demand".
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { atomicWrite, dirExists, ensureDir, readTextOrNullAsync } from "../utils/fs.js";
import type { WikiCategory, WikiPage } from "../utils/types.js";
import { parsePage, serializePage } from "./page.js";

/** Map category → wiki/<subdir>. */
export const CATEGORY_DIRS: Readonly<Record<WikiCategory, string>> = {
  concept: "concepts",
  entity: "entities",
  source: "sources",
  comparison: "comparisons",
  synthesis: "syntheses",
  query: "queries",
};

export interface StoreOptions {
  wikiRoot: string;
}

/**
 * WikiStore resolves paths inside the wiki root and performs atomic IO.
 * It does NOT emit events — the caller is responsible for higher-level effects.
 */
export class WikiStore {
  readonly wikiRoot: string;
  readonly wikiDir: string;

  constructor(opts: StoreOptions) {
    this.wikiRoot = resolve(opts.wikiRoot);
    this.wikiDir = join(this.wikiRoot, "wiki");
  }

  /** Ensure every category subdirectory exists. */
  async ensureLayout(): Promise<void> {
    await ensureDir(this.wikiDir);
    for (const dir of Object.values(CATEGORY_DIRS)) {
      await ensureDir(join(this.wikiDir, dir));
    }
  }

  /** Absolute path to the category directory. */
  categoryDir(category: WikiCategory): string {
    return join(this.wikiDir, CATEGORY_DIRS[category]);
  }

  /** Build an absolute path for a page slug inside a category. */
  pathFor(category: WikiCategory, slug: string): string {
    const safe = sanitizeSlug(slug);
    return join(this.categoryDir(category), `${safe}.md`);
  }

  /** Relative-to-wiki-root path for human-readable references. */
  relativePath(absPath: string): string {
    return relative(this.wikiRoot, absPath);
  }

  /** List all markdown pages across every category. */
  listAll(): string[] {
    const out: string[] = [];
    if (!dirExists(this.wikiDir)) return out;
    for (const dir of Object.values(CATEGORY_DIRS)) {
      const full = join(this.wikiDir, dir);
      if (!dirExists(full)) continue;
      for (const entry of readdirSync(full)) {
        if (entry.endsWith(".md")) out.push(join(full, entry));
      }
    }
    return out.sort();
  }

  /** Read and parse a page by absolute path. Returns null if missing. */
  async readPage(absPath: string): Promise<WikiPage | null> {
    const raw = await readTextOrNullAsync(absPath);
    if (raw === null) return null;
    return parsePage(absPath, raw);
  }

  /** Write a page atomically. Creates parent dirs if needed. */
  async writePage(page: WikiPage): Promise<void> {
    const serialized = serializePage(page);
    await atomicWrite(page.path, serialized);
  }

  /**
   * Find an existing page by title within a category, matching on
   * frontmatter.title case-insensitively. Used for idempotent upserts.
   */
  async findByTitle(category: WikiCategory, title: string): Promise<WikiPage | null> {
    const dir = this.categoryDir(category);
    if (!dirExists(dir)) return null;
    const needle = title.trim().toLowerCase();
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith(".md")) continue;
      const page = await this.readPage(join(dir, entry));
      if (page && page.frontmatter.title.trim().toLowerCase() === needle) {
        return page;
      }
    }
    return null;
  }

  /** Count markdown files, optionally filtered by category. */
  count(category?: WikiCategory): number {
    if (category) {
      const dir = this.categoryDir(category);
      if (!dirExists(dir)) return 0;
      return readdirSync(dir).filter((e) => e.endsWith(".md")).length;
    }
    return this.listAll().length;
  }
}

/**
 * Convert an arbitrary string into a safe slug: lowercase, hyphens,
 * strip anything that isn't alphanumeric/hyphen/underscore.
 */
export function sanitizeSlug(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const base = trimmed.endsWith(".md") ? trimmed.slice(0, -3) : trimmed;
  const cleaned = base
    .replace(/[^a-z0-9\-_\s]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return cleaned || "untitled";
}

/** Derive a slug from an absolute file path (drops directory + extension). */
export function slugFromPath(absPath: string): string {
  return sanitizeSlug(basename(absPath).replace(/\.md$/i, ""));
}

/** Collect file stats for a wiki page (size, mtime) without reading contents. */
export function pageStat(absPath: string): { size: number; mtimeMs: number } | null {
  try {
    const s = statSync(absPath);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}
