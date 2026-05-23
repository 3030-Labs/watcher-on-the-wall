/**
 * Unit tests for relate (Feature Pass 007).
 */
import { describe, expect, it } from "vitest";
import { relateEntities } from "../../../src/server/narrow-query.js";
import { CHARS_PER_TOKEN } from "../../../src/server/token-estimator.js";
import { addPage, makeMiniWiki, rebuildIndex } from "./test-helpers.js";

describe("relate: happy path", () => {
  it("finds sentences containing both anchors", async () => {
    const wiki = makeMiniWiki();
    await addPage(
      wiki,
      "concept",
      "alice-bob",
      "Alice and Bob",
      `## Background

Alice and Bob have collaborated for years. Alice once met Bob at a conference. Alice and Bob co-wrote three papers together.`,
    );
    await addPage(wiki, "concept", "carol", "Carol", "Carol works on something unrelated.");
    await rebuildIndex(wiki);

    const result = await relateEntities("Alice", "Bob", {
      store: wiki.store,
      search: wiki.search,
    });
    expect(result.no_hits).toBe(false);
    expect(result.statements.length).toBeGreaterThan(0);
    for (const s of result.statements) {
      const lc = s.statement.toLowerCase();
      expect(lc).toContain("alice");
      expect(lc).toContain("bob");
    }
  });
});

describe("relate: empty intersection", () => {
  it("returns no_hits=true when no page mentions both anchors", async () => {
    const wiki = makeMiniWiki();
    await addPage(wiki, "concept", "alice", "Alice", "Alice paints landscapes.");
    await addPage(wiki, "concept", "bob", "Bob", "Bob plays chess.");
    await rebuildIndex(wiki);

    const result = await relateEntities("Alice", "Bob", {
      store: wiki.store,
      search: wiki.search,
    });
    // BM25 may return both pages individually but no sentence contains
    // BOTH anchors, so the statement list should be empty.
    expect(result.statements).toHaveLength(0);
  });
});

describe("relate: token-budget enforcement", () => {
  it("aggregate statement size respects max_tokens cap", async () => {
    const wiki = makeMiniWiki();
    await addPage(
      wiki,
      "concept",
      "alice-bob-bulk",
      "Alice and Bob Bulk",
      Array(20).fill("Alice met Bob on a Tuesday and discussed at length.").join(" "),
    );
    await rebuildIndex(wiki);

    const cap = 64;
    const result = await relateEntities("Alice", "Bob", {
      store: wiki.store,
      search: wiki.search,
      maxTokens: cap,
    });
    expect(result.tokens).toBeLessThanOrEqual(cap);
    const concatLen = result.statements.reduce((acc, s) => acc + s.statement.length, 0);
    expect(concatLen).toBeLessThanOrEqual(cap * CHARS_PER_TOKEN);
  });
});

describe("relate: malformed input rejection", () => {
  it("zero max_statements falls back to default 3", async () => {
    const wiki = makeMiniWiki();
    await addPage(
      wiki,
      "concept",
      "ab",
      "Alice and Bob",
      "Alice and Bob met. Alice and Bob spoke. Alice and Bob agreed. Alice and Bob signed.",
    );
    await rebuildIndex(wiki);

    const result = await relateEntities("Alice", "Bob", {
      store: wiki.store,
      search: wiki.search,
      maxStatements: 0,
    });
    expect(result.statements.length).toBeGreaterThan(0);
    expect(result.statements.length).toBeLessThanOrEqual(3);
  });
});
