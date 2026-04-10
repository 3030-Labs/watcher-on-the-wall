/**
 * Unit tests for wiki/page.ts: parse, serialize, and new page construction.
 */
import { describe, expect, it } from "vitest";
import { newPage, parsePage, serializePage } from "../../src/wiki/page.js";

describe("parsePage", () => {
  it("parses a complete page with frontmatter", () => {
    const raw = `---
title: "Hash Chains"
category: "concept"
created: "2026-04-01"
updated: "2026-04-07"
sources:
  - "raw/notes.md"
related:
  - "concepts/merkle-trees"
tags:
  - crypto
  - data-structures
confidence: "high"
---

# Hash Chains

A hash chain is a sequence of hashes.
`;
    const page = parsePage("/tmp/wiki/concepts/hash-chains.md", raw);
    expect(page.frontmatter.title).toBe("Hash Chains");
    expect(page.frontmatter.category).toBe("concept");
    expect(page.frontmatter.sources).toEqual(["raw/notes.md"]);
    expect(page.frontmatter.related).toEqual(["concepts/merkle-trees"]);
    expect(page.frontmatter.tags).toEqual(["crypto", "data-structures"]);
    expect(page.frontmatter.confidence).toBe("high");
    expect(page.body).toContain("A hash chain is a sequence of hashes.");
    expect(page.path).toBe("/tmp/wiki/concepts/hash-chains.md");
  });

  it("fills in sensible defaults when frontmatter is missing", () => {
    const raw = `no frontmatter here`;
    const page = parsePage("/tmp/wiki/concepts/example.md", raw);
    expect(page.frontmatter.title).toBe("example");
    expect(page.frontmatter.category).toBe("concept");
    expect(page.frontmatter.sources).toEqual([]);
    expect(page.frontmatter.related).toEqual([]);
    expect(page.frontmatter.tags).toEqual([]);
    expect(page.frontmatter.confidence).toBe("medium");
    expect(page.frontmatter.created).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("normalizes invalid category to 'concept'", () => {
    const raw = `---
title: "X"
category: "bogus"
---
body`;
    const page = parsePage("/tmp/x.md", raw);
    expect(page.frontmatter.category).toBe("concept");
  });

  it("normalizes invalid confidence to 'medium'", () => {
    const raw = `---
title: "X"
confidence: "very high"
---
body`;
    const page = parsePage("/tmp/x.md", raw);
    expect(page.frontmatter.confidence).toBe("medium");
  });

  it("filters non-string entries from string arrays", () => {
    const raw = `---
title: "X"
tags:
  - valid
  - 42
  - true
  - "also-valid"
---
body`;
    const page = parsePage("/tmp/x.md", raw);
    expect(page.frontmatter.tags).toEqual(["valid", "also-valid"]);
  });

  it("derives title from filename when missing", () => {
    const raw = `body`;
    const page = parsePage("/tmp/wiki/concepts/hash-chains.md", raw);
    expect(page.frontmatter.title).toBe("hash chains");
  });

  it("trims body whitespace", () => {
    const raw = `---
title: "X"
---

   content

`;
    const page = parsePage("/tmp/x.md", raw);
    expect(page.body).toBe("content");
  });
});

describe("serializePage", () => {
  it("round-trips a parsed page", () => {
    const original = `---
title: Hash Chains
category: concept
created: "2026-04-01"
updated: "2026-04-07"
sources:
  - raw/notes.md
related:
  - concepts/merkle-trees
tags:
  - crypto
confidence: high
---

# Hash Chains

A hash chain is a sequence of hashes.
`;
    const parsed = parsePage("/tmp/wiki/concepts/hash-chains.md", original);
    const serialized = serializePage(parsed);
    const reparsed = parsePage("/tmp/wiki/concepts/hash-chains.md", serialized);
    expect(reparsed.frontmatter.title).toBe(parsed.frontmatter.title);
    expect(reparsed.frontmatter.category).toBe(parsed.frontmatter.category);
    expect(reparsed.frontmatter.tags).toEqual(parsed.frontmatter.tags);
    expect(reparsed.body).toBe(parsed.body);
  });

  it("produces YAML frontmatter", () => {
    const page = newPage("/tmp/x.md", "Example", "concept", "body here");
    const serialized = serializePage(page);
    expect(serialized).toMatch(/^---\n/);
    expect(serialized).toContain("title: Example");
    expect(serialized).toContain("category: concept");
    expect(serialized).toContain("body here");
  });
});

describe("newPage", () => {
  it("creates a page with defaults filled", () => {
    const page = newPage("/tmp/x.md", "Example", "entity", "some body");
    expect(page.frontmatter.title).toBe("Example");
    expect(page.frontmatter.category).toBe("entity");
    expect(page.frontmatter.sources).toEqual([]);
    expect(page.frontmatter.related).toEqual([]);
    expect(page.frontmatter.tags).toEqual([]);
    expect(page.frontmatter.confidence).toBe("medium");
    expect(page.body).toBe("some body");
  });

  it("accepts frontmatter overrides", () => {
    const page = newPage("/tmp/x.md", "Example", "concept", "body", {
      tags: ["a", "b"],
      confidence: "high",
      sources: ["raw/x.md"],
    });
    expect(page.frontmatter.tags).toEqual(["a", "b"]);
    expect(page.frontmatter.confidence).toBe("high");
    expect(page.frontmatter.sources).toEqual(["raw/x.md"]);
  });

  it("trims the body", () => {
    const page = newPage("/tmp/x.md", "X", "concept", "  content  \n\n");
    expect(page.body).toBe("content");
  });
});
