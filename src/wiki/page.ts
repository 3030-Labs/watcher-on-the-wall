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
import { getLogger } from "../utils/logger.js";

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
    if (typeof data.merged_into === "string") {
      frontmatter.merged_into = data.merged_into;
    }
  }
  const contradictions = normalizeStringArray(data.contradictions);
  if (contradictions.length > 0) {
    frontmatter.contradictions = contradictions;
  }
  if (typeof data.last_compiled === "string") {
    frontmatter.last_compiled = data.last_compiled;
  }
  if (typeof data.source_count === "number") {
    frontmatter.source_count = data.source_count;
  }
  if (typeof data.last_confirmed === "string") {
    frontmatter.last_confirmed = data.last_confirmed;
  }
  if (data.superseded_by === null || typeof data.superseded_by === "string") {
    frontmatter.superseded_by = data.superseded_by;
  }
  if (typeof data.rejected_at === "string") {
    frontmatter.rejected_at = data.rejected_at;
  }
  if (typeof data.rejection_note === "string") {
    frontmatter.rejection_note = data.rejection_note;
  }
  if (typeof data.domain === "string") {
    frontmatter.domain = data.domain;
  }
  if (typeof data.scope === "string") {
    frontmatter.scope = data.scope;
  }
  const keyTerms = normalizeStringArray(data.key_terms);
  if (keyTerms.length > 0) {
    frontmatter.key_terms = keyTerms;
  }
  if (typeof data.consolidated_into === "string") {
    frontmatter.consolidated_into = data.consolidated_into;
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
  if (fm.merged_into) data.merged_into = fm.merged_into;
  if (fm.contradictions && fm.contradictions.length > 0) {
    data.contradictions = fm.contradictions;
  }
  if (fm.last_compiled) data.last_compiled = fm.last_compiled;
  if (fm.source_count !== undefined) data.source_count = fm.source_count;
  if (fm.last_confirmed) data.last_confirmed = fm.last_confirmed;
  if (fm.superseded_by !== undefined) data.superseded_by = fm.superseded_by;
  if (fm.rejected_at) data.rejected_at = fm.rejected_at;
  if (fm.rejection_note) data.rejection_note = fm.rejection_note;
  if (fm.domain) data.domain = fm.domain;
  if (fm.scope) data.scope = fm.scope;
  if (fm.key_terms && fm.key_terms.length > 0) data.key_terms = fm.key_terms;
  if (fm.consolidated_into) data.consolidated_into = fm.consolidated_into;
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
  if (v !== undefined && v !== null) {
    getLogger("page").debug({ field: "category", value: v }, "coerced invalid frontmatter value");
  }
  return "concept";
}

function normalizeConfidence(v: unknown): ConfidenceLevel {
  if (typeof v === "string" && (VALID_CONFIDENCE as readonly string[]).includes(v)) {
    return v as ConfidenceLevel;
  }
  if (v !== undefined && v !== null) {
    getLogger("page").debug({ field: "confidence", value: v }, "coerced invalid frontmatter value");
  }
  return "medium";
}

function normalizeStatus(v: unknown): WikiPageStatus | null {
  if (v === "orphaned") return "orphaned";
  if (v === "merged") return "merged";
  if (v === "stale") return "stale";
  if (v === "consolidated") return "consolidated";
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
