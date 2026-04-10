/**
 * Provenance footer renderer. Appends a clickable provenance section to
 * wiki page bodies using Obsidian `[[wikilink]]` syntax, and strips it
 * during re-parse so the footer is always regenerated from frontmatter.
 */
import type { WikiFrontmatter } from "../utils/types.js";

/** Sentinel comment used to detect the provenance footer block. */
const FOOTER_START = "<!-- wotw:provenance:start -->";
const FOOTER_END = "<!-- wotw:provenance:end -->";

/**
 * Strip any existing provenance footer from a page body. Safe to call
 * on bodies that don't have one (returns the input unchanged).
 */
export function stripProvenanceFooter(body: string): string {
  const startIdx = body.indexOf(FOOTER_START);
  if (startIdx === -1) return body;
  // Remove everything from the separator before the sentinel to the end.
  // Walk backwards from startIdx to find a leading `---` separator.
  let cutStart = startIdx;
  const before = body.slice(0, startIdx);
  const lastSep = before.lastIndexOf("\n---\n");
  if (lastSep !== -1 && before.slice(lastSep).trim() === "---") {
    cutStart = lastSep;
  }
  return body.slice(0, cutStart).trimEnd();
}

/**
 * Render a provenance footer from frontmatter data. Returns the footer
 * block including the `---` separator and sentinel comments.
 */
export function renderProvenanceFooter(fm: WikiFrontmatter): string {
  const sources = fm.sources ?? [];
  const links = sources.map((s) => `[[${s}]]`).join(" | ");
  const compiled = fm.last_compiled ?? fm.updated ?? new Date().toISOString();
  const count = fm.source_count ?? sources.length;

  const lines = [
    "",
    "---",
    FOOTER_START,
    `**Sources:** ${links || "_none_"}`,
    `**Compiled:** ${compiled}`,
    `**Corroborating sources:** ${count}`,
    FOOTER_END,
  ];
  return lines.join("\n");
}

/**
 * Ensure a page body has an up-to-date provenance footer. Strips any
 * existing footer and appends a fresh one from the frontmatter.
 */
export function ensureProvenanceFooter(body: string, fm: WikiFrontmatter): string {
  const clean = stripProvenanceFooter(body);
  return clean + renderProvenanceFooter(fm);
}
