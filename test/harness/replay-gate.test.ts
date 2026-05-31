/**
 * Phase 4 — the PR-GATE. Runs entirely on RECORDED CASSETTES: deterministic,
 * offline, free. No external API is called, so a flaky provider can never block
 * a merge. This test runs inside the normal `pnpm test` gate, so a cassette that
 * regresses below its recorded baseline (beyond the margin) FAILS the PR.
 *
 * It also enforces corpus integrity: every recorded baseline must have a
 * matching cassette and a matching gold fixture, so the three never silently
 * drift apart.
 *
 * The LIVE drift check (current model vs baseline) is a separate, scheduled,
 * non-PR-gating workflow (.github/workflows/multi-llm-drift.yml) — it needs keys
 * and must never block merges.
 */
import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadGoldFixtures } from "./gold.js";
import { loadCassette, listCassettes } from "./cassette.js";
import { scoreFacts } from "./score.js";
import { checkRegression } from "./regression.js";
import type { BaselineStore } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = join(HERE, "..", "fixtures", "gold");
const CASSETTE_DIR = join(GOLD_DIR, "cassettes");
const BASELINES_PATH = join(GOLD_DIR, "baselines.json");

const baselines: BaselineStore = existsSync(BASELINES_PATH)
  ? (JSON.parse(readFileSync(BASELINES_PATH, "utf8")) as BaselineStore)
  : {};
const fixturesById = new Map(loadGoldFixtures(GOLD_DIR).map((f) => [f.id, f]));
const providers = Object.keys(baselines);

describe("cassette replay PR-gate", () => {
  it("has at least one provider baseline recorded", () => {
    // Guards against an empty corpus silently passing the gate.
    expect(providers.length).toBeGreaterThan(0);
  });

  for (const provider of providers) {
    describe(`provider: ${provider}`, () => {
      const fixtureIds = Object.keys(baselines[provider]);

      it("every baseline has a matching cassette and gold fixture (corpus integrity)", () => {
        for (const id of fixtureIds) {
          expect(
            loadCassette(CASSETTE_DIR, provider, id),
            `${provider}/${id} cassette missing`,
          ).not.toBeNull();
          expect(fixturesById.has(id), `${provider}/${id} gold fixture missing`).toBe(true);
        }
      });

      it("every recorded cassette scores at or above its baseline (no regression)", () => {
        const regressed: string[] = [];
        for (const id of fixtureIds) {
          const cas = loadCassette(CASSETTE_DIR, provider, id);
          const fixture = fixturesById.get(id);
          if (!cas || !fixture) continue;
          const score = scoreFacts(fixture.goldFacts, cas.facts);
          const reg = checkRegression(provider, id, score, baselines);
          if (reg.regressed) regressed.push(`${id}: ${reg.reason}`);
        }
        expect(regressed, `regressions:\n${regressed.join("\n")}`).toHaveLength(0);
      });
    });
  }

  it("recorded cassettes on disk are all covered by a baseline (no orphans)", () => {
    for (const provider of providers) {
      const onDisk = listCassettes(CASSETTE_DIR, provider);
      const baselined = new Set(Object.keys(baselines[provider]));
      const orphans = onDisk.filter((id) => !baselined.has(id));
      expect(orphans, `${provider} orphan cassettes: ${orphans.join(", ")}`).toHaveLength(0);
    }
  });
});
