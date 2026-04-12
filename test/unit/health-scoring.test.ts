/**
 * Unit tests for health scoring functions in src/wiki/health.ts.
 * Tests cover each scoring factor individually plus the weighted average.
 */
import { describe, expect, it } from "vitest";
import type { ProvenanceRecord, WotwConfig } from "../../src/utils/types.js";
import {
  computeLinkHealth,
  computePageHealthScore,
  computeSourceAvailability,
  computeStaleness,
  computeWeightedScore,
  type PageHealthScore,
} from "../../src/wiki/health.js";
import { defaultConfig } from "../../src/daemon/config.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newPage } from "../../src/wiki/page.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-health-"));
}

function makeConfig(overrides?: Partial<WotwConfig["health"]>): WotwConfig {
  const cfg = defaultConfig();
  if (overrides) {
    cfg.health = { ...cfg.health, ...overrides };
    if (overrides.weights) cfg.health.weights = { ...cfg.health.weights, ...overrides.weights };
  }
  return cfg;
}

function makeRecord(overrides: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    id: "test",
    seq: 1,
    timestamp: new Date().toISOString(),
    type: "ingest",
    source_files: [],
    source_hashes: [],
    prompt_hash: "test",
    model_id: "test",
    response_hash: "test",
    wiki_files_written: [],
    wiki_file_hashes_after: {},
    previous_id: null,
    previous_chain_hash: "0".repeat(64),
    chain_hash: "a".repeat(64),
    ...overrides,
  };
}

describe("computeStaleness", () => {
  const thresholds = [7, 30, 90, 180, 365];
  const scores = [100, 80, 60, 40, 20, 0];

  it("page with recent source (< 7 days) scores 100", () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    const records = [
      makeRecord({ timestamp: recent, wiki_files_written: ["wiki/concepts/test.md"] }),
    ];
    expect(computeStaleness("wiki/concepts/test.md", records, thresholds, scores, now)).toBe(100);
  });

  it("page with 1-year-old source scores 0", () => {
    const now = new Date();
    const old = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000).toISOString();
    const records = [makeRecord({ timestamp: old, wiki_files_written: ["wiki/concepts/test.md"] })];
    expect(computeStaleness("wiki/concepts/test.md", records, thresholds, scores, now)).toBe(0);
  });

  it("page with no provenance records gets lowest score", () => {
    expect(computeStaleness("wiki/concepts/test.md", [], thresholds, scores)).toBe(0);
  });

  it("page updated 60 days ago scores 60 (within 90-day threshold)", () => {
    const now = new Date();
    const sixtyDays = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();
    const records = [
      makeRecord({ timestamp: sixtyDays, wiki_files_written: ["wiki/concepts/test.md"] }),
    ];
    expect(computeStaleness("wiki/concepts/test.md", records, thresholds, scores, now)).toBe(60);
  });
});

describe("computeSourceAvailability", () => {
  it("orphaned page scores 0", () => {
    expect(computeSourceAvailability("wiki/test.md", [], "/tmp", true)).toBe(0);
  });

  it("page with no provenance scores 100 (no penalty)", () => {
    expect(computeSourceAvailability("wiki/test.md", [], "/tmp", false)).toBe(100);
  });

  it("page with all sources existing scores 100", () => {
    const root = tmp();
    const rawDir = join(root, "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "note.md"), "content");
    const records = [
      makeRecord({
        source_files: ["raw/note.md"],
        wiki_files_written: ["wiki/test.md"],
      }),
    ];
    expect(computeSourceAvailability("wiki/test.md", records, root, false)).toBe(100);
  });

  it("page with some sources missing scores proportionally", () => {
    const root = tmp();
    const rawDir = join(root, "raw");
    mkdirSync(rawDir, { recursive: true });
    writeFileSync(join(rawDir, "note1.md"), "exists");
    // note2.md doesn't exist
    const records = [
      makeRecord({
        source_files: ["raw/note1.md", "raw/note2.md"],
        wiki_files_written: ["wiki/test.md"],
      }),
    ];
    expect(computeSourceAvailability("wiki/test.md", records, root, false)).toBe(50);
  });
});

describe("computeLinkHealth", () => {
  it("page with all valid links scores 100", () => {
    const slugs = new Set(["concepts/foo", "entities/bar"]);
    const result = computeLinkHealth("Check [[concepts/foo]] and [[entities/bar]].", slugs);
    expect(result.score).toBe(100);
    expect(result.broken).toHaveLength(0);
  });

  it("page with 2/4 broken links scores 50", () => {
    const slugs = new Set(["concepts/foo", "entities/bar"]);
    const body = "See [[concepts/foo]], [[entities/bar]], [[missing/one]], [[missing/two]].";
    const result = computeLinkHealth(body, slugs);
    expect(result.score).toBe(50);
    expect(result.broken).toHaveLength(2);
  });

  it("page with no links scores 100 (not penalized)", () => {
    const result = computeLinkHealth("No links here.", new Set());
    expect(result.score).toBe(100);
    expect(result.broken).toHaveLength(0);
  });
});

describe("computeWeightedScore", () => {
  const defaultWeights = defaultConfig().health.weights;

  it("perfect factors produce score of 100", () => {
    const factors: PageHealthScore["factors"] = {
      staleness: 100,
      sourceAvailability: 100,
      linkHealth: 100,
      duplicateRisk: 0,
      contradictionRisk: 0,
    };
    expect(computeWeightedScore(factors, defaultWeights)).toBe(100);
  });

  it("all-zero factors produce score of 0", () => {
    const factors: PageHealthScore["factors"] = {
      staleness: 0,
      sourceAvailability: 0,
      linkHealth: 0,
      duplicateRisk: 100,
      contradictionRisk: 100,
    };
    expect(computeWeightedScore(factors, defaultWeights)).toBe(0);
  });

  it("custom weights are respected", () => {
    const factors: PageHealthScore["factors"] = {
      staleness: 100,
      sourceAvailability: 0,
      linkHealth: 0,
      duplicateRisk: 0,
      contradictionRisk: 0,
    };
    // Only staleness matters with weight 1.0.
    const weights = {
      staleness: 1.0,
      source_availability: 0,
      link_health: 0,
      duplicate_risk: 0,
      contradiction_risk: 0,
    };
    expect(computeWeightedScore(factors, weights)).toBe(100);
  });
});

describe("computePageHealthScore", () => {
  it("produces correct score structure", () => {
    const root = tmp();
    const wikiDir = join(root, "wiki", "concepts");
    mkdirSync(wikiDir, { recursive: true });
    writeFileSync(join(wikiDir, "test.md"), "---\ntitle: Test\n---\nContent");
    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const page = newPage(join(wikiDir, "test.md"), "Test", "concept", "Content");
    search.rebuild([page]);
    const config = makeConfig();
    config.wiki_root = root;

    const result = computePageHealthScore(
      join(wikiDir, "test.md"),
      store,
      [],
      search,
      new Set(["concepts/test"]),
      config,
      "Content",
      "Test",
      [],
      false,
    );
    expect(result.page).toContain("concepts/test.md");
    // No provenance -> staleness=0, not orphaned + no records -> sourceAvailability=100,
    // no wikilinks -> linkHealth=100, single page -> duplicateRisk=0, contradictionRisk=0.
    // Weighted: 0*0.25 + 100*0.25 + 100*0.2 + 100*0.15 + 100*0.15 = 75
    expect(result.score).toBe(75);
    expect(result.factors).toBeDefined();
    expect(result.factors.staleness).toBeDefined();
    expect(result.factors.sourceAvailability).toBeDefined();
    expect(result.factors.linkHealth).toBeDefined();
    expect(result.factors.duplicateRisk).toBeDefined();
    expect(result.factors.contradictionRisk).toBe(0);
  });
});
