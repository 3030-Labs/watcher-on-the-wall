/**
 * Cassette record/replay — Phase 3 (feeds Phase 4 CI).
 *
 * A cassette is a recorded provider extraction output for one (provider,
 * fixture). Recording requires a live model; replay is deterministic, free, and
 * offline — so the PR-gating CI suite can score regressions WITHOUT calling any
 * external API (a flaky provider must never block merge).
 *
 * Cassettes store the parsed `ExtractedFact[]` (the extractor's OUTPUT), not raw
 * HTTP bodies — the unit under regression test is the fact set, and this keeps
 * replay decoupled from provider wire formats and parser internals.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Cassette, ExtractedFact } from "./types.js";

export function cassettePath(dir: string, provider: string, fixtureId: string): string {
  return join(dir, provider, `${fixtureId}.json`);
}

export function saveCassette(dir: string, cassette: Cassette): string {
  const p = cassettePath(dir, cassette.provider, cassette.fixtureId);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cassette, null, 2) + "\n", "utf8");
  return p;
}

export function loadCassette(dir: string, provider: string, fixtureId: string): Cassette | null {
  const p = cassettePath(dir, provider, fixtureId);
  if (!existsSync(p)) return null;
  const parsed = JSON.parse(readFileSync(p, "utf8")) as Cassette;
  return parsed;
}

export function hasCassette(dir: string, provider: string, fixtureId: string): boolean {
  return existsSync(cassettePath(dir, provider, fixtureId));
}

/** List the fixtureIds recorded for a provider. */
export function listCassettes(dir: string, provider: string): string[] {
  const providerDir = join(dir, provider);
  if (!existsSync(providerDir)) return [];
  return readdirSync(providerDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

export function makeCassette(
  provider: string,
  fixtureId: string,
  model: string,
  facts: ExtractedFact[],
  recordedAt: string,
): Cassette {
  return { provider, fixtureId, model, facts, recordedAt };
}
