/**
 * Phase 3 — cassette record/replay tests. Proves a recorded extraction
 * round-trips offline (the property the Phase 4 PR-gate depends on).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  makeCassette,
  saveCassette,
  loadCassette,
  hasCassette,
  listCassettes,
} from "./cassette.js";
import type { ExtractedFact } from "./types.js";

const facts: ExtractedFact[] = [
  {
    entity: "Tardigrades",
    statement: "first described in 1773",
    questions: ["When were tardigrades described?"],
  },
  { entity: "Tardigrades", statement: "survive the vacuum of space", questions: [] },
];

describe("cassette record/replay", () => {
  it("round-trips a recorded extraction offline", () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-cassette-"));
    const c = makeCassette(
      "anthropic",
      "f1-tardigrades",
      "claude-sonnet-4-5",
      facts,
      "2026-05-31T00:00:00Z",
    );
    saveCassette(dir, c);
    expect(hasCassette(dir, "anthropic", "f1-tardigrades")).toBe(true);
    const loaded = loadCassette(dir, "anthropic", "f1-tardigrades");
    expect(loaded).not.toBeNull();
    expect(loaded!.facts).toEqual(facts);
    expect(loaded!.model).toBe("claude-sonnet-4-5");
    expect(loaded!.provider).toBe("anthropic");
  });

  it("returns null for an unrecorded (provider, fixture)", () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-cassette-"));
    expect(loadCassette(dir, "openai", "nope")).toBeNull();
    expect(hasCassette(dir, "openai", "nope")).toBe(false);
  });

  it("lists recorded fixtureIds for a provider, sorted", () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-cassette-"));
    saveCassette(dir, makeCassette("gemini", "f2", "gemini-2.0-pro", facts, "t"));
    saveCassette(dir, makeCassette("gemini", "f1", "gemini-2.0-pro", facts, "t"));
    expect(listCassettes(dir, "gemini")).toEqual(["f1", "f2"]);
    expect(listCassettes(dir, "ollama")).toEqual([]);
  });
});
