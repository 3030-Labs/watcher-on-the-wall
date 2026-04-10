/**
 * Cross-reference manager. Keeps `related:` frontmatter bidirectional
 * across wiki pages. When page A lists page B as related, page B should
 * list page A in return.
 *
 * The manager works on slugs relative to the wiki directory (e.g.
 * `concepts/provenance-chain`). Bidirectional repair runs over a page set
 * and writes back only the pages that actually changed.
 */
import { relative } from "node:path";
import type { WikiPage } from "../utils/types.js";
import type { WikiStore } from "./store.js";

/** Turn an absolute page path into a wiki-relative slug (no extension). */
export function toWikiSlug(store: WikiStore, absPath: string): string {
  const rel = relative(store.wikiDir, absPath).replace(/\\/g, "/");
  return rel.replace(/\.md$/i, "");
}

/**
 * Ensure bidirectional related links across every provided page.
 * Returns the list of pages whose frontmatter was mutated in memory.
 * The caller is responsible for persisting them (via store.writePage).
 */
export function repairBidirectionalLinks(store: WikiStore, pages: WikiPage[]): WikiPage[] {
  const bySlug = new Map<string, WikiPage>();
  for (const p of pages) bySlug.set(toWikiSlug(store, p.path), p);

  const mutated = new Set<string>();

  for (const page of pages) {
    const mySlug = toWikiSlug(store, page.path);
    for (const related of page.frontmatter.related) {
      const target = bySlug.get(normalizeSlug(related));
      if (!target) continue; // unknown reference — ignore silently
      if (!target.frontmatter.related.map(normalizeSlug).includes(mySlug)) {
        target.frontmatter.related = [...target.frontmatter.related, mySlug];
        mutated.add(toWikiSlug(store, target.path));
      }
    }
  }

  return pages.filter((p) => mutated.has(toWikiSlug(store, p.path)));
}

/**
 * Strip leading slashes / .md suffix for comparison. Accepts both
 * `concepts/foo` and `concepts/foo.md`.
 */
export function normalizeSlug(s: string): string {
  return s.trim().replace(/^\/+/, "").replace(/\.md$/i, "");
}

/**
 * Given a markdown body, extract `[[wiki-link]]` style references
 * and return the set of unique slugs.
 */
export function extractWikiLinks(body: string): string[] {
  const pattern = /\[\[([^\]]+)\]\]/g;
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(body)) !== null) {
    const raw = m[1];
    if (raw) out.add(normalizeSlug(raw));
  }
  return [...out];
}
