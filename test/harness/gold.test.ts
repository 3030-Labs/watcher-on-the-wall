/**
 * Phase 3 — gold corpus integrity test. Locks the 20-fixture corpus into the
 * suite: every fixture loads, has a readable source, and carries gold facts with
 * non-empty entity + statement. (Scoring quality is exercised by the live
 * runner; this guards the corpus shape so a malformed gold.json fails fast.)
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadGoldFixtures, readFixtureSource } from "./gold.js";

const GOLD_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "gold");

describe("gold corpus", () => {
  const fixtures = loadGoldFixtures(GOLD_DIR);

  it("loads exactly 20 fixtures", () => {
    expect(fixtures).toHaveLength(20);
  });

  it("covers markdown, code, and pdf-text formats", () => {
    const formats = new Set(fixtures.map((f) => f.format));
    expect(formats.has("markdown")).toBe(true);
    expect(formats.has("code")).toBe(true);
    expect(formats.has("pdf-text")).toBe(true);
  });

  it("every fixture has a readable source and well-formed gold facts", () => {
    for (const f of fixtures) {
      expect(existsSync(f.sourcePath), `${f.id} source missing`).toBe(true);
      expect(readFixtureSource(f).length, `${f.id} source empty`).toBeGreaterThan(0);
      expect(f.goldFacts.length, `${f.id} has no gold facts`).toBeGreaterThanOrEqual(4);
      for (const gf of f.goldFacts) {
        expect(gf.entity.trim().length, `${f.id} empty entity`).toBeGreaterThan(0);
        expect(gf.statement.trim().length, `${f.id} empty statement`).toBeGreaterThan(0);
      }
    }
  });

  it("has at least 100 gold facts across the corpus", () => {
    const total = fixtures.reduce((n, f) => n + f.goldFacts.length, 0);
    expect(total).toBeGreaterThanOrEqual(100);
  });
});
