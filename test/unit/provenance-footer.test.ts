/**
 * Unit tests for wiki/provenance-footer.ts.
 */
import { describe, expect, it } from "vitest";
import {
  ensureProvenanceFooter,
  renderProvenanceFooter,
  stripProvenanceFooter,
} from "../../src/wiki/provenance-footer.js";
import type { WikiFrontmatter } from "../../src/utils/types.js";

function baseFrontmatter(overrides: Partial<WikiFrontmatter> = {}): WikiFrontmatter {
  return {
    title: "Test Page",
    category: "concept",
    created: "2026-04-09",
    updated: "2026-04-09",
    sources: ["raw/doc1.md", "raw/doc2.pdf"],
    related: [],
    tags: [],
    confidence: "medium",
    last_compiled: "2026-04-09T20:00:00.000Z",
    source_count: 2,
    ...overrides,
  };
}

describe("renderProvenanceFooter", () => {
  it("renders wikilinks for all sources", () => {
    const footer = renderProvenanceFooter(baseFrontmatter());
    expect(footer).toContain("[[raw/doc1.md]]");
    expect(footer).toContain("[[raw/doc2.pdf]]");
    expect(footer).toContain("**Sources:**");
    expect(footer).toContain("**Compiled:** 2026-04-09T20:00:00.000Z");
    expect(footer).toContain("**Corroborating sources:** 2");
  });

  it("handles empty sources gracefully", () => {
    const footer = renderProvenanceFooter(baseFrontmatter({ sources: [] }));
    expect(footer).toContain("**Sources:** _none_");
  });

  it("source_count matches frontmatter", () => {
    const fm = baseFrontmatter({ source_count: 5 });
    const footer = renderProvenanceFooter(fm);
    expect(footer).toContain("**Corroborating sources:** 5");
  });
});

describe("stripProvenanceFooter", () => {
  it("strips an existing footer", () => {
    const body =
      "Some content\n\n---\n<!-- wotw:provenance:start -->\n**Sources:** [[raw/a.md]]\n<!-- wotw:provenance:end -->";
    const stripped = stripProvenanceFooter(body);
    expect(stripped).toBe("Some content");
    expect(stripped).not.toContain("wotw:provenance");
  });

  it("returns unchanged body when no footer present", () => {
    const body = "Just some content\n\nWith paragraphs.";
    expect(stripProvenanceFooter(body)).toBe(body);
  });
});

describe("ensureProvenanceFooter", () => {
  it("adds a footer to a body without one", () => {
    const body = "Page content here.";
    const fm = baseFrontmatter();
    const result = ensureProvenanceFooter(body, fm);
    expect(result).toContain("Page content here.");
    expect(result).toContain("[[raw/doc1.md]]");
    expect(result).toContain("<!-- wotw:provenance:start -->");
    expect(result).toContain("<!-- wotw:provenance:end -->");
  });

  it("replaces an existing footer with updated data", () => {
    const body =
      "Content\n\n---\n<!-- wotw:provenance:start -->\n**Sources:** [[old.md]]\n<!-- wotw:provenance:end -->";
    const fm = baseFrontmatter({ sources: ["raw/new.md"] });
    const result = ensureProvenanceFooter(body, fm);
    expect(result).not.toContain("[[old.md]]");
    expect(result).toContain("[[raw/new.md]]");
    // Should only have one footer.
    expect(result.split("wotw:provenance:start").length).toBe(2);
  });

  it("frontmatter source_count matches sources array length", () => {
    const fm = baseFrontmatter({ sources: ["a.md", "b.md", "c.md"], source_count: 3 });
    const result = ensureProvenanceFooter("Body.", fm);
    expect(result).toContain("**Corroborating sources:** 3");
  });
});
