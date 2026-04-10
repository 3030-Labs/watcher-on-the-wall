/**
 * Wiki page model. A wiki page is a markdown file with YAML frontmatter.
 * This module parses, validates, and serializes them.
 */
import matter from "gray-matter";
import type {
  ConfidenceLevel,
  WikiCategory,
  WikiFrontmatter,
  WikiPage,
  WikiPageStatus,
} from "../utils/types.js";

const VALID_CATEGORIES: readonly WikiCategory[] = [
  "concept",
  "entity",
  "source",
  "comparison",
  "synthesis",
  "query",
];

const VALID_CONFIDENCE: readonly ConfidenceLevel[] = ["high", "medium", "low"];

/**
 * Parse a raw markdown file with frontmatter into a {@link WikiPage}.
 * Fills in missing fields with sensible defaults rather than throwing.
 */
export function parsePage(filePath: string, raw: string): WikiPage {
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const now = new Date().toISOString().slice(0, 10);
  const category = normalizeCategory(data.category);
  const confidence = normalizeConfidence(data.confidence);
  const status = normalizeStatus(data.status);
  const frontmatter: WikiFrontmatter = {
    title: typeof data.title === "string" ? data.title : deriveTitle(filePath),
    category,
    created: typeof data.created === "string" ? data.created : now,
    updated: typeof data.updated === "string" ? data.updated : now,
    sources: normalizeStringArray(data.sources),
    related: normalizeStringArray(data.related),
    tags: normalizeStringArray(data.tags),
    confidence,
  };
  if (status) {
    frontmatter.status = status;
    if (typeof data.orphaned_at === "string") {
      frontmatter.orphaned_at = data.orphaned_at;
    }
    const orphanedSource = normalizeStringArray(data.orphaned_source);
    if (orphanedSource.length > 0) {
      frontmatter.orphaned_source = orphanedSource;
    }
  }

  return {
    path: filePath,
    frontmatter,
    body: parsed.content.trim(),
    raw,
  };
}

/**
 * Serialize a {@link WikiPage} back to a markdown string with frontmatter.
 */
export function serializePage(page: Pick<WikiPage, "frontmatter" | "body">): string {
  const fm = page.frontmatter;
  // matter.stringify automatically handles YAML escaping. Orphan-lifecycle
  // fields are only emitted when present so active pages stay clean.
  const data: Record<string, unknown> = {
    title: fm.title,
    category: fm.category,
    created: fm.created,
    updated: fm.updated,
    sources: fm.sources,
    related: fm.related,
    tags: fm.tags,
    confidence: fm.confidence,
  };
  if (fm.status) data.status = fm.status;
  if (fm.orphaned_at) data.orphaned_at = fm.orphaned_at;
  if (fm.orphaned_source && fm.orphaned_source.length > 0) {
    data.orphaned_source = fm.orphaned_source;
  }
  return matter.stringify(page.body, data);
}

/**
 * Create a new blank page with defaults filled in.
 */
export function newPage(
  path: string,
  title: string,
  category: WikiCategory,
  body: string,
  opts: Partial<WikiFrontmatter> = {},
): WikiPage {
  const now = new Date().toISOString().slice(0, 10);
  const frontmatter: WikiFrontmatter = {
    title,
    category,
    created: opts.created ?? now,
    updated: opts.updated ?? now,
    sources: opts.sources ?? [],
    related: opts.related ?? [],
    tags: opts.tags ?? [],
    confidence: opts.confidence ?? "medium",
  };
  return {
    path,
    frontmatter,
    body: body.trim(),
    raw: "",
  };
}

function normalizeCategory(v: unknown): WikiCategory {
  if (typeof v === "string" && (VALID_CATEGORIES as readonly string[]).includes(v)) {
    return v as WikiCategory;
  }
  return "concept";
}

function normalizeConfidence(v: unknown): ConfidenceLevel {
  if (typeof v === "string" && (VALID_CONFIDENCE as readonly string[]).includes(v)) {
    return v as ConfidenceLevel;
  }
  return "medium";
}

function normalizeStatus(v: unknown): WikiPageStatus | null {
  if (v === "orphaned") return "orphaned";
  return null;
}

function normalizeStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

function deriveTitle(filePath: string): string {
  const base = filePath.split("/").pop() ?? filePath;
  return base.replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}
