/**
 * Unit tests for the `wotw search` command logic.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { loadAllPages } from "../../src/ingestion/wiki-writer.js";
import { serializePage, newPage } from "../../src/wiki/page.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-search-"));
}

function setupStore(wikiRoot: string): WikiStore {
  const store = new WikiStore({ wikiRoot });
  mkdirSync(join(wikiRoot, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "entities"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "sources"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "comparisons"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "syntheses"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "queries"), { recursive: true });
  return store;
}

describe("search", () => {
  it("finds pages matching search terms", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();

    const page1 = newPage(
      join(root, "wiki", "concepts", "machine-learning.md"),
      "Machine Learning",
      "concept",
      "Machine learning is a subset of artificial intelligence focused on algorithms that learn from data.",
    );
    const page2 = newPage(
      join(root, "wiki", "concepts", "databases.md"),
      "Databases",
      "concept",
      "A database is an organized collection of structured data.",
    );
    writeFileSync(page1.path, serializePage(page1));
    writeFileSync(page2.path, serializePage(page2));

    const pages = await loadAllPages(store);
    search.rebuild(pages);
    const hits = search.search("machine learning", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.title).toBe("Machine Learning");
  });

  it("returns empty results for no matches", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();

    const page = newPage(
      join(root, "wiki", "concepts", "test.md"),
      "Test",
      "concept",
      "Just a test page.",
    );
    writeFileSync(page.path, serializePage(page));

    const pages = await loadAllPages(store);
    search.rebuild(pages);
    const hits = search.search("xyznonexistent", 10);
    expect(hits.length).toBe(0);
  });

  it("respects limit parameter", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();

    // Create multiple matching pages.
    for (let i = 0; i < 5; i++) {
      const page = newPage(
        join(root, "wiki", "concepts", `alpha-${i}.md`),
        `Alpha Page ${i}`,
        "concept",
        "Alpha content with common keywords for searching.",
      );
      writeFileSync(page.path, serializePage(page));
    }

    const pages = await loadAllPages(store);
    search.rebuild(pages);
    const hits = search.search("alpha", 3);
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it("snippets contain relevant text", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const search = new WikiSearch();

    const page = newPage(
      join(root, "wiki", "concepts", "quantum.md"),
      "Quantum Computing",
      "concept",
      "Quantum computing leverages quantum mechanics to process information using qubits.",
    );
    writeFileSync(page.path, serializePage(page));

    const pages = await loadAllPages(store);
    search.rebuild(pages);
    const hits = search.search("quantum", 10);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.snippet).toContain("quantum");
  });

  it("handles empty wiki gracefully", () => {
    const search = new WikiSearch();
    search.rebuild([]);
    const hits = search.search("anything", 10);
    expect(hits).toEqual([]);
  });
});
