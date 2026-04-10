/**
 * In-memory full-text search over wiki pages using minisearch.
 * Re-indexes on every rebuild; no on-disk state.
 */
import MiniSearch from "minisearch";
import type { WikiPage } from "../utils/types.js";

export interface SearchHit {
  path: string;
  title: string;
  category: string;
  score: number;
  snippet: string;
}

interface IndexDoc {
  id: string;
  path: string;
  title: string;
  category: string;
  tags: string;
  body: string;
}

/**
 * Small wrapper around MiniSearch with sensible defaults for the wiki.
 */
export class WikiSearch {
  private readonly engine: MiniSearch<IndexDoc>;
  private byId = new Map<string, IndexDoc>();

  constructor() {
    this.engine = new MiniSearch<IndexDoc>({
      fields: ["title", "tags", "body"],
      storeFields: ["path", "title", "category"],
      searchOptions: {
        boost: { title: 3, tags: 2 },
        fuzzy: 0.2,
        prefix: true,
      },
    });
  }

  /** Replace the entire index with the given pages. */
  rebuild(pages: WikiPage[]): void {
    this.engine.removeAll();
    this.byId.clear();
    const docs = pages.map((p) => toDoc(p));
    for (const d of docs) this.byId.set(d.id, d);
    this.engine.addAll(docs);
  }

  /** Upsert a single page into the index. */
  upsert(page: WikiPage): void {
    const doc = toDoc(page);
    if (this.byId.has(doc.id)) this.engine.replace(doc);
    else this.engine.add(doc);
    this.byId.set(doc.id, doc);
  }

  /** Drop a page from the index by its absolute path. */
  remove(absPath: string): void {
    const id = absPath;
    if (this.byId.has(id)) {
      this.engine.remove({ id } as IndexDoc);
      this.byId.delete(id);
    }
  }

  /** Query the index. Returns ranked hits with snippets. */
  search(query: string, limit = 20): SearchHit[] {
    if (!query.trim()) return [];
    // OR-combination is the right default for natural-language questions —
    // AND would zero-out any query containing stop words or uncommon terms.
    const results = this.engine.search(query, { combineWith: "OR" });
    return results.slice(0, limit).map((r) => {
      const doc = this.byId.get(r.id as string);
      return {
        path: (r as unknown as { path: string }).path,
        title: (r as unknown as { title: string }).title,
        category: (r as unknown as { category: string }).category,
        score: r.score,
        snippet: doc ? makeSnippet(doc.body, query) : "",
      };
    });
  }

  /** Number of indexed documents. */
  size(): number {
    return this.byId.size;
  }
}

function toDoc(page: WikiPage): IndexDoc {
  return {
    id: page.path,
    path: page.path,
    title: page.frontmatter.title,
    category: page.frontmatter.category,
    tags: page.frontmatter.tags.join(" "),
    body: page.body,
  };
}

/** Return ~240 characters around the first query term hit. */
function makeSnippet(body: string, query: string): string {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const lower = body.toLowerCase();
  let best = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  if (best === -1) return body.slice(0, 240).trim();
  const start = Math.max(0, best - 80);
  const end = Math.min(body.length, best + 160);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < body.length ? "…" : "";
  return `${prefix}${body.slice(start, end).trim()}${suffix}`.replace(/\s+/g, " ");
}
