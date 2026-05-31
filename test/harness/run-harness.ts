/**
 * Live harness runner — Phase 3 (record baselines + cassettes) / Phase 4 (check).
 *
 * Runs the SHIPPED fact extractor over each gold fixture for a provider and
 * either RECORDS a baseline + cassette (first green run) or CHECKS the current
 * extraction against the recorded baseline (regression gate). This is NOT a
 * vitest unit — it needs a live model (CLI mode = claude binary, key-free; or an
 * API key for non-Anthropic providers). The deterministic scoring/regression
 * logic it calls is unit-tested separately.
 *
 * Usage:
 *   npx tsx test/harness/run-harness.ts \
 *     --provider anthropic --runtime cli --model claude-sonnet-4-5 \
 *     --mode record [--concurrency 4]
 *   npx tsx test/harness/run-harness.ts --provider anthropic --runtime cli --mode check
 *
 * --mode check exits non-zero if any fixture regressed (the PR-gate behavior).
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { defaultConfig } from "../../src/daemon/config.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { extractFactsFromPage } from "../../src/facts/extractor.js";
import type { RuntimeMode, WotwConfig } from "../../src/utils/types.js";
import { loadGoldFixtures, readFixtureSource } from "./gold.js";
import { scoreFacts } from "./score.js";
import { checkRegression, baselineFromScore } from "./regression.js";
import { makeCassette, saveCassette, loadCassette } from "./cassette.js";
import type { BaselineStore, ExtractedFact, GoldFixture } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLD_DIR = join(HERE, "..", "fixtures", "gold");
const CASSETTE_DIR = join(GOLD_DIR, "cassettes");
const BASELINES_PATH = join(GOLD_DIR, "baselines.json");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const provider = arg("provider", "anthropic");
const runtime = arg("runtime", "cli") as RuntimeMode;
const model = arg("model", "claude-sonnet-4-5");
const mode = arg("mode", "record");
const concurrency = Math.max(1, parseInt(arg("concurrency", "4"), 10));

function buildConfig(): WotwConfig {
  const c = defaultConfig();
  const wikiRoot = mkdtempSync(join(tmpdir(), "wotw-harness-"));
  c.wiki_root = wikiRoot;
  c.raw_path = join(wikiRoot, "raw");
  c.execution.mode = runtime === "cli" ? "cli" : "api";
  // Pin the standalone claude binary by ABSOLUTE path. Running this harness via
  // `npx tsx` prepends node_modules/.bin to PATH, so a bare "claude" resolves to
  // the repo's @anthropic-ai/claude-code launcher (native binary not installed)
  // instead of the working global install. Bypass PATH resolution entirely.
  const stdClaude = join(homedir(), ".local", "bin", "claude");
  c.execution.cli_path =
    process.env.WOTW_CLAUDE_CLI_PATH ?? (existsSync(stdClaude) ? stdClaude : "claude");
  c.execution.cli_model = model;
  c.llm.provider = provider as WotwConfig["llm"]["provider"];
  c.llm.model = model;
  c.fact_extraction.enabled = true; // force-on for the harness
  return c;
}

function loadBaselines(): BaselineStore {
  if (!existsSync(BASELINES_PATH)) return {};
  return JSON.parse(readFileSync(BASELINES_PATH, "utf8")) as BaselineStore;
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()));
  return out;
}

interface FixtureOutcome {
  fixture: GoldFixture;
  facts: ExtractedFact[];
  ran: boolean;
  skipReason?: string;
}

async function extractOne(config: WotwConfig, fixture: GoldFixture): Promise<FixtureOutcome> {
  const costTracker = new CostTracker({
    trackFile: join(config.wiki_root, "cost.jsonl"),
    maxDailyUsd: 1000,
    maxPerIngestUsd: 1000,
    maxPerQueryUsd: 1000,
  });
  const res = await extractFactsFromPage({
    config,
    runtimeMode: runtime,
    wikiPageId: fixture.id,
    pageBody: readFixtureSource(fixture),
    title: fixture.title,
    costTracker,
    model,
  });
  return { fixture, facts: res.facts, ran: res.ran, skipReason: res.skipReason };
}

// Offline source: replay an extraction from a recorded cassette.
function replayOne(fixture: GoldFixture): FixtureOutcome {
  const cas = loadCassette(CASSETTE_DIR, provider, fixture.id);
  if (!cas) return { fixture, facts: [], ran: false, skipReason: "no cassette" };
  return { fixture, facts: cas.facts, ran: true };
}

const OFFLINE = mode === "rescore" || mode === "replay";

async function main(): Promise<void> {
  const config = OFFLINE ? null : buildConfig();
  const fixtures = loadGoldFixtures(GOLD_DIR);
  const recordedAt = new Date().toISOString();
  console.log(
    `[harness] provider=${provider} runtime=${runtime} model=${model} mode=${mode} fixtures=${fixtures.length}` +
      (OFFLINE ? " (offline: cassette source)" : ""),
  );

  const outcomes = OFFLINE
    ? fixtures.map((f) => replayOne(f))
    : await pool(fixtures, concurrency, (f) => extractOne(config!, f));

  const baselines = loadBaselines();
  let regressions = 0;
  let recorded = 0;
  const rows: string[] = [];

  for (const o of outcomes) {
    if (!o.ran || o.facts.length === 0) {
      rows.push(`SKIP  ${o.fixture.id}  (ran=${o.ran}${o.skipReason ? ` ${o.skipReason}` : ""})`);
      continue;
    }
    const score = scoreFacts(o.fixture.goldFacts, o.facts);
    const pr = `P=${score.precision.toFixed(2)} R=${score.recall.toFixed(2)} F1=${score.f1.toFixed(2)} (${o.facts.length} facts)`;

    const isCheck = mode === "check" || mode === "replay";
    if (isCheck) {
      const reg = checkRegression(provider, o.fixture.id, score, baselines);
      if (reg.regressed) {
        regressions++;
        rows.push(`REGRESS ${o.fixture.id}  ${pr}  -- ${reg.reason}`);
      } else if (reg.baseline === null) {
        rows.push(`NEW   ${o.fixture.id}  ${pr}  (no baseline)`);
      } else {
        rows.push(`OK    ${o.fixture.id}  ${pr}`);
      }
    } else {
      // record (live) or rescore (from cassette): (re)write the baseline.
      baselines[provider] = baselines[provider] ?? {};
      baselines[provider][o.fixture.id] = baselineFromScore(score, model, recordedAt);
      if (mode === "record") {
        saveCassette(
          CASSETTE_DIR,
          makeCassette(provider, o.fixture.id, model, o.facts, recordedAt),
        );
      }
      recorded++;
      rows.push(`${mode === "record" ? "REC  " : "RESC "} ${o.fixture.id}  ${pr}`);
    }
  }

  rows.sort();
  console.log(rows.join("\n"));

  if (mode === "record" || mode === "rescore") {
    writeFileSync(BASELINES_PATH, JSON.stringify(baselines, null, 2) + "\n", "utf8");
    const provScores = Object.values(baselines[provider] ?? {});
    const avgP = provScores.reduce((s, b) => s + b.precision, 0) / (provScores.length || 1);
    const avgR = provScores.reduce((s, b) => s + b.recall, 0) / (provScores.length || 1);
    console.log(
      `\n[harness] recorded ${recorded} baselines + cassettes for ${provider}. ` +
        `avg P=${avgP.toFixed(3)} avg R=${avgR.toFixed(3)}. baselines -> ${BASELINES_PATH}`,
    );
  } else {
    console.log(`\n[harness] check complete: ${regressions} regression(s).`);
    if (regressions > 0) process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[harness] fatal:", err);
  process.exitCode = 2;
});
