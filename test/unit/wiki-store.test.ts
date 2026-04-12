/**
 * Unit tests for WikiStore: layout, path resolution, read/write, slug utilities.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirExists } from "../../src/utils/fs.js";
import { newPage } from "../../src/wiki/page.js";
import { CATEGORY_DIRS, WikiStore, sanitizeSlug, slugFromPath } from "../../src/wiki/store.js";

function tmpWikiRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-store-"));
}

describe("sanitizeSlug", () => {
  it("lowercases and hyphenates whitespace", () => {
    expect(sanitizeSlug("Hello World")).toBe("hello-world");
  });

  it("strips punctuation", () => {
    expect(sanitizeSlug("Hash Chains!?")).toBe("hash-chains");
  });

  it("collapses repeated hyphens", () => {
    expect(sanitizeSlug("a - - b")).toBe("a-b");
  });

  it("strips leading/trailing hyphens", () => {
    expect(sanitizeSlug("---hello---")).toBe("hello");
  });

  it("drops a trailing .md", () => {
    expect(sanitizeSlug("example.md")).toBe("example");
  });

  it("returns 'untitled-<hash>' for empty input to avoid collisions", () => {
    const a = sanitizeSlug("");
    const b = sanitizeSlug("!!!");
    expect(a).toMatch(/^untitled-[0-9a-f]{8}$/);
    expect(b).toMatch(/^untitled-[0-9a-f]{8}$/);
    // Different inputs produce different suffixes
    expect(a).not.toBe(b);
  });
});

describe("slugFromPath", () => {
  it("takes the basename and drops the extension", () => {
    expect(slugFromPath("/tmp/wiki/concepts/hash-chains.md")).toBe("hash-chains");
  });

  it("normalizes mixed case", () => {
    expect(slugFromPath("/tmp/Hash Chains.md")).toBe("hash-chains");
  });
});

describe("WikiStore.ensureLayout", () => {
  it("creates wiki/ and every category subdirectory", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    expect(dirExists(store.wikiDir)).toBe(true);
    for (const dir of Object.values(CATEGORY_DIRS)) {
      expect(dirExists(join(store.wikiDir, dir))).toBe(true);
    }
  });

  it("is idempotent", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    await store.ensureLayout();
    expect(dirExists(store.wikiDir)).toBe(true);
  });
});

describe("WikiStore.pathFor", () => {
  it("resolves to category directory with safe slug", () => {
    const store = new WikiStore({ wikiRoot: "/tmp/root" });
    const p = store.pathFor("concept", "Hash Chains");
    expect(p).toContain("concepts");
    expect(p.endsWith("hash-chains.md")).toBe(true);
  });

  it("maps each category to the right directory", () => {
    const store = new WikiStore({ wikiRoot: "/tmp/root" });
    expect(store.pathFor("entity", "x")).toContain("entities");
    expect(store.pathFor("source", "x")).toContain("sources");
    expect(store.pathFor("comparison", "x")).toContain("comparisons");
    expect(store.pathFor("synthesis", "x")).toContain("syntheses");
    expect(store.pathFor("query", "x")).toContain("queries");
  });
});

describe("WikiStore.writePage + readPage", () => {
  it("round-trips a page via disk", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const path = store.pathFor("concept", "Example");
    const page = newPage(path, "Example", "concept", "hello world", {
      tags: ["tag1"],
    });
    await store.writePage(page);
    const read = await store.readPage(path);
    expect(read).not.toBeNull();
    expect(read!.frontmatter.title).toBe("Example");
    expect(read!.frontmatter.tags).toEqual(["tag1"]);
    expect(read!.body).toBe("hello world");
  });

  it("readPage returns null for missing files", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    const result = await store.readPage(join(root, "nope.md"));
    expect(result).toBeNull();
  });

  it("atomicWrite guarantees final file matches serialized content", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const path = store.pathFor("entity", "Git");
    const page = newPage(path, "Git", "entity", "distributed VCS");
    await store.writePage(page);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("title: Git");
    expect(text).toContain("distributed VCS");
  });
});

describe("WikiStore.listAll + count", () => {
  it("returns empty when no pages exist", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    expect(store.listAll()).toEqual([]);
    expect(store.count()).toBe(0);
  });

  it("lists pages across categories, sorted", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    await store.writePage(newPage(store.pathFor("concept", "alpha"), "alpha", "concept", "a"));
    await store.writePage(newPage(store.pathFor("entity", "beta"), "beta", "entity", "b"));
    await store.writePage(newPage(store.pathFor("concept", "gamma"), "gamma", "concept", "c"));
    const all = store.listAll();
    expect(all).toHaveLength(3);
    // Sorted
    expect([...all].sort()).toEqual(all);
    expect(store.count()).toBe(3);
    expect(store.count("concept")).toBe(2);
    expect(store.count("entity")).toBe(1);
    expect(store.count("source")).toBe(0);
  });
});

describe("WikiStore.findByTitle", () => {
  it("finds a page by title case-insensitively", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const path = store.pathFor("concept", "Hash Chains");
    await store.writePage(newPage(path, "Hash Chains", "concept", "body"));
    const found = await store.findByTitle("concept", "hash chains");
    expect(found).not.toBeNull();
    expect(found!.frontmatter.title).toBe("Hash Chains");
  });

  it("returns null when not found", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const found = await store.findByTitle("concept", "nope");
    expect(found).toBeNull();
  });

  it("returns null when the category directory does not exist", async () => {
    const root = tmpWikiRoot();
    const store = new WikiStore({ wikiRoot: root });
    // Skip ensureLayout on purpose
    const found = await store.findByTitle("concept", "anything");
    expect(found).toBeNull();
  });
});

describe("WikiStore.relativePath", () => {
  it("returns path relative to wiki_root", () => {
    const store = new WikiStore({ wikiRoot: "/tmp/root" });
    expect(store.relativePath("/tmp/root/wiki/concepts/x.md")).toBe("wiki/concepts/x.md");
  });
});
