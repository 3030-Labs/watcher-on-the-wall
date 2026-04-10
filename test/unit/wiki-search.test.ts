/**
 * Unit tests for WikiSearch: full-text search over wiki pages using minisearch.
 */
import { describe, expect, it } from "vitest";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage } from "../../src/wiki/page.js";
import type { WikiPage } from "../../src/utils/types.js";

function page(
  title: string,
  category: "concept" | "entity" = "concept",
  body = "",
  tags: string[] = [],
): WikiPage {
  const path = `/wiki/${category}s/${title.toLowerCase().replace(/\s+/g, "-")}.md`;
  return newPage(path, title, category, body, { tags });
}

describe("WikiSearch.rebuild", () => {
  it("indexes all provided pages", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Hash Chains", "concept", "A hash chain is a sequence of hashes"),
      page("Merkle Trees", "concept", "Merkle trees are tree-structured"),
    ]);
    expect(search.size()).toBe(2);
  });

  it("replaces prior content", () => {
    const search = new WikiSearch();
    search.rebuild([page("Alpha")]);
    search.rebuild([page("Beta"), page("Gamma")]);
    expect(search.size()).toBe(2);
  });
});

describe("WikiSearch.search", () => {
  it("finds pages by title", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Hash Chains", "concept", "A hash chain is a sequence of hashes"),
      page("Merkle Trees", "concept", "Merkle trees are tree-structured"),
    ]);
    const results = search.search("hash");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Hash Chains");
  });

  it("finds pages by body content", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Hash Chains", "concept", "A sequence where each element commits to the previous"),
    ]);
    const results = search.search("commits");
    expect(results.length).toBe(1);
  });

  it("uses OR combination for natural-language queries", () => {
    const search = new WikiSearch();
    search.rebuild([page("Hash Chains", "concept", "A hash chain is a sequence of hashes")]);
    // "what is a hash chain" — if AND were used, this would zero out because
    // "what" is not in the body.
    const results = search.search("what is a hash chain");
    expect(results.length).toBeGreaterThan(0);
  });

  it("boosts title matches over body matches", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Other Page", "concept", "this page mentions hashes incidentally"),
      page("Hashes", "concept", "a body without much detail"),
    ]);
    const results = search.search("hashes");
    expect(results[0]!.title).toBe("Hashes");
  });

  it("boosts tag matches", () => {
    const search = new WikiSearch();
    search.rebuild([
      page("Generic", "concept", "nothing special", []),
      page("Special", "concept", "nothing special", ["crypto"]),
    ]);
    const results = search.search("crypto");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Special");
  });

  it("returns empty for empty query", () => {
    const search = new WikiSearch();
    search.rebuild([page("Alpha")]);
    expect(search.search("")).toEqual([]);
    expect(search.search("   ")).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const search = new WikiSearch();
    const pages: WikiPage[] = [];
    for (let i = 0; i < 30; i++) {
      pages.push(page(`Item ${i}`, "concept", "content with a common word"));
    }
    search.rebuild(pages);
    const results = search.search("content", 5);
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it("includes a snippet with the match", () => {
    const search = new WikiSearch();
    search.rebuild([
      page(
        "Example",
        "concept",
        "This is a long body that contains the word provenance somewhere in the middle of the text.",
      ),
    ]);
    const results = search.search("provenance");
    expect(results[0]!.snippet).toContain("provenance");
  });
});

describe("WikiSearch.upsert + remove", () => {
  it("upsert adds a new page", () => {
    const search = new WikiSearch();
    search.upsert(page("Alpha", "concept", "content about alpha"));
    expect(search.size()).toBe(1);
    expect(search.search("alpha").length).toBeGreaterThan(0);
  });

  it("upsert updates an existing page at the same path", () => {
    const search = new WikiSearch();
    const p = page("Alpha", "concept", "initial content");
    search.upsert(p);
    p.body = "new content with provenance";
    search.upsert(p);
    expect(search.size()).toBe(1);
    expect(search.search("provenance").length).toBeGreaterThan(0);
  });

  it("remove drops the page from the index", () => {
    const search = new WikiSearch();
    const p = page("Alpha", "concept", "content");
    search.upsert(p);
    expect(search.size()).toBe(1);
    search.remove(p.path);
    expect(search.size()).toBe(0);
    expect(search.search("alpha")).toEqual([]);
  });

  it("remove is a no-op for unknown paths", () => {
    const search = new WikiSearch();
    search.upsert(page("Alpha"));
    search.remove("/nowhere/ghost.md");
    expect(search.size()).toBe(1);
  });
});
