/**
 * Unit tests for src/facts/store.ts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FactStore, factHash, questionHash } from "../../../src/facts/store.js";

function tmpDb(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-fact-store-")), "facts.db");
}

describe("FactStore: schema + migration", () => {
  it("initializes user_version=1 on first open", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    expect(store.schemaVersion()).toBe(1);
    store.close();
  });

  it("CREATE IF NOT EXISTS is idempotent across reopens", () => {
    const path = tmpDb();
    const a = new FactStore({ path });
    a.insertFact({ wiki_page_id: "wiki/concepts/x.md", entity: "X", statement: "X is a thing." });
    a.close();
    const b = new FactStore({ path });
    expect(b.activeCount()).toBe(1);
    expect(b.schemaVersion()).toBe(1);
    b.close();
  });

  it("refuses to open a future schema version", () => {
    const path = tmpDb();
    const store = new FactStore({ path });
    // Manually bump the version higher than what we know.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (store as any).db.pragma("user_version = 99");
    store.close();
    expect(() => new FactStore({ path })).toThrow(/refusing to downgrade/);
  });
});

describe("FactStore: CRUD", () => {
  it("inserts a fact and reads it back", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    const { id, fact_hash, created_at } = store.insertFact({
      wiki_page_id: "wiki/concepts/photosynthesis.md",
      entity: "Photosynthesis",
      statement: "Photosynthesis converts light into chemical energy.",
    });
    expect(id).toBeGreaterThan(0);
    expect(fact_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const got = store.getFact(id);
    expect(got?.entity).toBe("Photosynthesis");
    expect(got?.fact_hash).toBe(fact_hash);
    expect(got?.superseded_at).toBeNull();
    store.close();
  });

  it("listActive returns only non-superseded facts", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    const a = store.insertFact({ wiki_page_id: "p.md", entity: "A", statement: "A is a." });
    store.insertFact({ wiki_page_id: "p.md", entity: "B", statement: "B is b." });
    const superseded = store.supersedeByWikiPage("p.md");
    expect(superseded).toHaveLength(2);
    expect(superseded).toContain(a.fact_hash);
    expect(store.listActive()).toHaveLength(0);
    expect(store.activeCount()).toBe(0);
    store.close();
  });

  it("listByWikiPage returns active + superseded ordered by created_at", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    store.insertFact({ wiki_page_id: "p.md", entity: "A", statement: "old" });
    store.supersedeByWikiPage("p.md");
    store.insertFact({ wiki_page_id: "p.md", entity: "A", statement: "new" });
    const all = store.listByWikiPage("p.md");
    expect(all).toHaveLength(2);
    expect(all[0]!.superseded_at).not.toBeNull();
    expect(all[1]!.superseded_at).toBeNull();
    store.close();
  });
});

describe("FactStore: questions", () => {
  it("inserts and lists questions for a fact", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    const { id } = store.insertFact({
      wiki_page_id: "p.md",
      entity: "Photosynthesis",
      statement: "It produces glucose.",
    });
    const inserted = store.insertQuestions(id, [
      "What does photosynthesis produce?",
      "What is the output of photosynthesis?",
    ]);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]!.fact_id).toBe(id);
    expect(inserted[0]!.question_hash).toMatch(/^[0-9a-f]{64}$/);
    const all = store.listActiveQuestions();
    expect(all).toHaveLength(2);
    store.close();
  });

  it("rejects duplicate questions per fact (UNIQUE constraint)", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    const { id } = store.insertFact({
      wiki_page_id: "p.md",
      entity: "X",
      statement: "Y",
    });
    const first = store.insertQuestions(id, ["q1", "q2"]);
    const second = store.insertQuestions(id, ["q1", "q3"]);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(1);
    expect(store.listActiveQuestions()).toHaveLength(3);
    store.close();
  });

  it("supersedes parent fact → questions still exist but are filtered by listActiveQuestions", () => {
    const store = new FactStore({ inMemory: true, path: ":memory:" });
    const { id } = store.insertFact({
      wiki_page_id: "p.md",
      entity: "X",
      statement: "Y",
    });
    store.insertQuestions(id, ["q1"]);
    store.supersedeByWikiPage("p.md");
    expect(store.listActiveQuestions()).toHaveLength(0);
    store.close();
  });
});

describe("FactStore: hashing helpers", () => {
  it("factHash is deterministic for identical inputs", () => {
    const a = factHash("E", "S", "p.md", "2026-05-23T12:00:00.000Z");
    const b = factHash("E", "S", "p.md", "2026-05-23T12:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
  it("factHash differs for different timestamps (so re-extraction lands in new row)", () => {
    const a = factHash("E", "S", "p.md", "2026-05-23T12:00:00.000Z");
    const b = factHash("E", "S", "p.md", "2026-05-23T12:00:01.000Z");
    expect(a).not.toBe(b);
  });
  it("questionHash is deterministic per (fact_id, question)", () => {
    const a = questionHash(42, "What is X?");
    const b = questionHash(42, "What is X?");
    expect(a).toBe(b);
    expect(questionHash(43, "What is X?")).not.toBe(a);
  });
});
