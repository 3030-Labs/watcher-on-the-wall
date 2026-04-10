/**
 * Unit tests for cross-reference.ts: wiki link extraction, slug normalization,
 * and bidirectional related-link repair.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { newPage } from "../../src/wiki/page.js";
import {
  extractWikiLinks,
  normalizeSlug,
  repairBidirectionalLinks,
  toWikiSlug,
} from "../../src/wiki/cross-reference.js";

function tmpStore(): WikiStore {
  const root = mkdtempSync(join(tmpdir(), "wotw-xref-"));
  return new WikiStore({ wikiRoot: root });
}

describe("normalizeSlug", () => {
  it("strips leading slashes", () => {
    expect(normalizeSlug("/concepts/foo")).toBe("concepts/foo");
    expect(normalizeSlug("///a")).toBe("a");
  });

  it("strips .md suffix", () => {
    expect(normalizeSlug("concepts/foo.md")).toBe("concepts/foo");
    expect(normalizeSlug("concepts/foo.MD")).toBe("concepts/foo");
  });

  it("trims whitespace", () => {
    expect(normalizeSlug("  concepts/foo  ")).toBe("concepts/foo");
  });
});

describe("extractWikiLinks", () => {
  it("finds [[wiki-link]] references", () => {
    const body = "See [[concepts/hash-chains]] and [[entities/git]].";
    const links = extractWikiLinks(body);
    expect(links).toEqual(["concepts/hash-chains", "entities/git"]);
  });

  it("dedupes repeated references", () => {
    const body = "[[a]] and [[a]] again and [[b]]";
    const links = extractWikiLinks(body);
    expect(links).toEqual(["a", "b"]);
  });

  it("returns empty for no links", () => {
    expect(extractWikiLinks("just some prose")).toEqual([]);
  });

  it("normalizes each extracted link", () => {
    const body = "[[concepts/foo.md]]";
    expect(extractWikiLinks(body)).toEqual(["concepts/foo"]);
  });
});

describe("toWikiSlug", () => {
  it("converts an absolute path to a wiki-relative slug", () => {
    const store = new WikiStore({ wikiRoot: "/tmp/root" });
    expect(toWikiSlug(store, "/tmp/root/wiki/concepts/hash-chains.md")).toBe(
      "concepts/hash-chains",
    );
  });
});

describe("repairBidirectionalLinks", () => {
  it("adds a back-reference when A lists B but B does not list A", () => {
    const store = tmpStore();
    const a = newPage(store.pathFor("concept", "a"), "A", "concept", "body", {
      related: ["concepts/b"],
    });
    const b = newPage(store.pathFor("concept", "b"), "B", "concept", "body", {
      related: [],
    });
    const mutated = repairBidirectionalLinks(store, [a, b]);
    expect(mutated).toHaveLength(1);
    expect(mutated[0]!.frontmatter.title).toBe("B");
    expect(b.frontmatter.related).toContain("concepts/a");
  });

  it("does nothing when links are already bidirectional", () => {
    const store = tmpStore();
    const a = newPage(store.pathFor("concept", "a"), "A", "concept", "body", {
      related: ["concepts/b"],
    });
    const b = newPage(store.pathFor("concept", "b"), "B", "concept", "body", {
      related: ["concepts/a"],
    });
    const mutated = repairBidirectionalLinks(store, [a, b]);
    expect(mutated).toHaveLength(0);
  });

  it("ignores references to unknown pages", () => {
    const store = tmpStore();
    const a = newPage(store.pathFor("concept", "a"), "A", "concept", "body", {
      related: ["concepts/ghost"],
    });
    const mutated = repairBidirectionalLinks(store, [a]);
    expect(mutated).toHaveLength(0);
  });

  it("handles .md suffix and leading slash in related refs", () => {
    const store = tmpStore();
    const a = newPage(store.pathFor("concept", "a"), "A", "concept", "body", {
      related: ["/concepts/b.md"],
    });
    const b = newPage(store.pathFor("concept", "b"), "B", "concept", "body", {
      related: [],
    });
    const mutated = repairBidirectionalLinks(store, [a, b]);
    expect(mutated).toHaveLength(1);
    expect(b.frontmatter.related).toContain("concepts/a");
  });

  it("supports cross-category back-references", () => {
    const store = tmpStore();
    const concept = newPage(
      store.pathFor("concept", "hash-chains"),
      "Hash Chains",
      "concept",
      "body",
      { related: ["entities/git"] },
    );
    const entity = newPage(store.pathFor("entity", "git"), "Git", "entity", "body", {
      related: [],
    });
    const mutated = repairBidirectionalLinks(store, [concept, entity]);
    expect(mutated).toHaveLength(1);
    expect(entity.frontmatter.related).toContain("concepts/hash-chains");
  });
});
