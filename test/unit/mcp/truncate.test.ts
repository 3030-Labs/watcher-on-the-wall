/**
 * Unit tests for src/server/truncate.ts — the sentence-boundary
 * truncation utility shared by the progressive and narrow-query tools.
 */
import { describe, expect, it } from "vitest";
import {
  charsToTokens,
  CHARS_PER_TOKEN,
  extractOutline,
  extractSectionLedes,
  extractSentencesContainingAll,
  firstParagraph,
  sentenceSplit,
  slugify,
  splitFrontmatter,
  tokensToChars,
  truncateToTokenBudget,
} from "../../../src/server/truncate.js";

describe("truncate: char/token boundary", () => {
  it("4 chars per token", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(tokensToChars(10)).toBe(40);
    expect(charsToTokens(40)).toBe(10);
    expect(charsToTokens(41)).toBe(11);
  });
  it("non-positive token budgets resolve to zero chars", () => {
    expect(tokensToChars(0)).toBe(0);
    expect(tokensToChars(-5)).toBe(0);
  });
});

describe("truncate: truncateToTokenBudget", () => {
  it("returns text unchanged when within budget", () => {
    const out = truncateToTokenBudget("short text.", 100);
    expect(out).toBe("short text.");
  });
  it("returns empty for zero / negative budget", () => {
    expect(truncateToTokenBudget("anything", 0)).toBe("");
    expect(truncateToTokenBudget("anything", -1)).toBe("");
  });
  it("cuts on sentence boundary when possible", () => {
    const text =
      "First sentence is here. Second sentence is here. Third sentence is here. Fourth sentence is here.";
    // 16 tokens = 64 chars cap. That covers the first two sentences with room
    // to spare; the cut should land on the period at the end of "Second
    // sentence is here." (49 chars in).
    const out = truncateToTokenBudget(text, 16);
    expect(out.endsWith(".")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(16 * CHARS_PER_TOKEN);
    expect(out).not.toContain("Third sentence");
    expect(out).not.toContain("Fourth sentence");
  });
  it("falls back to word boundary when no sentence boundary in lookback", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu";
    const out = truncateToTokenBudget(text, 5);
    // 5 tokens = 20 chars cap. We should not split inside a word.
    expect(out.length).toBeLessThanOrEqual(20);
    expect(out.endsWith(" ")).toBe(false);
    expect(text.startsWith(out)).toBe(true);
  });
  it("never exceeds the char-equivalent budget", () => {
    const text = "x".repeat(10_000);
    const out = truncateToTokenBudget(text, 64);
    expect(out.length).toBeLessThanOrEqual(64 * CHARS_PER_TOKEN);
  });
});

describe("truncate: splitFrontmatter", () => {
  it("returns empty frontmatter when none present", () => {
    const r = splitFrontmatter("just markdown\n\nbody");
    expect(r.frontmatter).toBe("");
    expect(r.body).toBe("just markdown\n\nbody");
  });
  it("strips a YAML frontmatter block", () => {
    const md = "---\ntitle: Foo\ncategory: concept\n---\nbody starts here";
    const r = splitFrontmatter(md);
    expect(r.frontmatter).toContain("title: Foo");
    expect(r.body).toBe("body starts here");
  });
});

describe("truncate: extractOutline", () => {
  it("returns the header list, ignoring fenced code blocks", () => {
    const md = `## Real Section
content
\`\`\`
## Not a header (in fence)
\`\`\`
### Sub Section
more content`;
    const outline = extractOutline(md);
    expect(outline.map((o) => o.title)).toEqual(["Real Section", "Sub Section"]);
    expect(outline[0]!.level).toBe(2);
    expect(outline[1]!.level).toBe(3);
  });
  it("strips frontmatter before scanning", () => {
    const md = "---\ntitle: X\n---\n# Section\ncontent";
    const outline = extractOutline(md);
    expect(outline).toHaveLength(1);
    expect(outline[0]!.title).toBe("Section");
  });
});

describe("truncate: extractSectionLedes", () => {
  it("returns the first paragraph after each header", () => {
    const md = `## Section A
first paragraph of A.

later paragraph not included.

## Section B
first paragraph of B.`;
    const ledes = extractSectionLedes(md);
    expect(ledes).toHaveLength(2);
    expect(ledes[0]!.lede).toBe("first paragraph of A.");
    expect(ledes[1]!.lede).toBe("first paragraph of B.");
  });
  it("falls back to first paragraph when no headers", () => {
    const md = "lone paragraph one.\n\nlone paragraph two.";
    const ledes = extractSectionLedes(md);
    expect(ledes).toHaveLength(1);
    expect(ledes[0]!.header).toBeNull();
    expect(ledes[0]!.lede).toBe("lone paragraph one.");
  });
});

describe("truncate: sentenceSplit + extractSentencesContainingAll", () => {
  it("splits on .!? followed by whitespace", () => {
    const sentences = sentenceSplit("First sentence. Second one! Third? Fourth.");
    expect(sentences).toHaveLength(4);
  });
  it("returns sentences containing every anchor", () => {
    const text =
      "Alice studies Bob. Bob never met Carol. Alice and Bob both worked on Dexter. Alice eats pizza.";
    const result = extractSentencesContainingAll(text, ["Alice", "Bob"], 1000);
    expect(result).toContain("Alice studies Bob.");
    expect(result).toContain("Alice and Bob both worked on Dexter.");
    expect(result).not.toContain("Bob never met Carol.");
  });
  it("enforces the token budget", () => {
    const text =
      "Alice meets Bob. Alice walks with Bob. Alice runs with Bob. Alice cycles with Bob. Alice swims with Bob.";
    const result = extractSentencesContainingAll(text, ["Alice", "Bob"], 8);
    // 8 tokens = 32 chars. Should return at most a sentence or two.
    const total = result.join(" ").length;
    expect(total).toBeLessThanOrEqual(32);
  });
});

describe("truncate: firstParagraph + slugify", () => {
  it("firstParagraph returns first block separated by blank line", () => {
    const text = "alpha\nbeta\n\ngamma\ndelta";
    expect(firstParagraph(text)).toBe("alpha\nbeta");
  });
  it("slugify lowercases and hyphenates", () => {
    expect(slugify("Some Title Here!")).toBe("some-title-here");
    expect(slugify("Edge—Case Test")).toBe("edgecase-test");
  });
});
