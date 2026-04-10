/**
 * Unit tests for deduplication detection logic in src/wiki/health.ts.
 */
import { describe, expect, it } from "vitest";
import { groupDuplicates } from "../../src/wiki/health.js";

describe("groupDuplicates", () => {
  it("groups a simple pair", () => {
    const pairs: Array<[string, string]> = [["a.md", "b.md"]];
    const groups = groupDuplicates(pairs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pages.sort()).toEqual(["a.md", "b.md"]);
  });

  it("does not flag two completely different pages", () => {
    const groups = groupDuplicates([]);
    expect(groups).toHaveLength(0);
  });

  it("transitively groups A~B and B~C into {A, B, C}", () => {
    const pairs: Array<[string, string]> = [
      ["a.md", "b.md"],
      ["b.md", "c.md"],
    ];
    const groups = groupDuplicates(pairs);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.pages.sort()).toEqual(["a.md", "b.md", "c.md"]);
  });

  it("keeps independent pairs as separate groups", () => {
    const pairs: Array<[string, string]> = [
      ["a.md", "b.md"],
      ["c.md", "d.md"],
    ];
    const groups = groupDuplicates(pairs);
    expect(groups).toHaveLength(2);
    const sorted = groups.map((g) => g.pages.sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
    expect(sorted[0]).toEqual(["a.md", "b.md"]);
    expect(sorted[1]).toEqual(["c.md", "d.md"]);
  });
});
