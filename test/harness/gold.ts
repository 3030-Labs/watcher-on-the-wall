/**
 * Gold-fixture loader — Phase 3.
 *
 * A gold fixture is a directory under test/fixtures/gold/<id>/ containing:
 *   - source.md | source.code.txt | source.pdf.txt   (the input document)
 *   - gold.json                                        (the gold fact set)
 *
 * gold.json shape:
 *   { "title": "...", "format": "markdown", "source": "source.md",
 *     "goldFacts": [ { "entity": "...", "statement": "...", "aliases": [...] } ] }
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { GoldFact, GoldFixture } from "./types.js";

interface GoldJson {
  title: string;
  format: GoldFixture["format"];
  source: string;
  goldFacts: GoldFact[];
}

export function loadGoldFixtures(goldDir: string): GoldFixture[] {
  if (!existsSync(goldDir)) return [];
  const ids = readdirSync(goldDir)
    .filter((name) => {
      const p = join(goldDir, name);
      return statSync(p).isDirectory() && existsSync(join(p, "gold.json"));
    })
    .sort();

  return ids.map((id) => {
    const meta = JSON.parse(readFileSync(join(goldDir, id, "gold.json"), "utf8")) as GoldJson;
    return {
      id,
      title: meta.title,
      format: meta.format,
      sourcePath: join(goldDir, id, meta.source),
      goldFacts: meta.goldFacts,
    };
  });
}

export function readFixtureSource(fixture: GoldFixture): string {
  return readFileSync(fixture.sourcePath, "utf8");
}
