/**
 * G5 attestation benchmark (Pass 018, v0.8.2).
 *
 * Measures the HMAC overhead per provenance append:
 *   baseline: ProvenanceChain with NO HMAC (no tenantId, no keyStore)
 *   attested: ProvenanceChain with KeyStore-backed HMAC signing
 *
 * Hard gate: p99 added latency must be < 5ms. The real append-path
 * crypto cost is typically well under 100µs (HMAC of two 64-char hex
 * strings), but p99 on multi-tenant CI runners can spike from GC
 * pauses or runner contention; the budget is set generously to
 * tolerate CI noise while still catching a real ≥10× regression.
 *
 * Methodology: 1000 iterations each, sequential. Sorts the timings
 * and reports p50/p95/p99 for both, plus the delta.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvenanceChain, type ProvenanceAppendInput } from "../../src/provenance/chain.js";
import { KeyStore } from "../../src/keys/store.js";

const ITERATIONS = 1000;
const P99_BUDGET_MS = 5.0;
const WS = "tenant-aaaa-1111";

function makeInput(seq: number): ProvenanceAppendInput {
  return {
    type: "ingest",
    source_files: [`raw/note-${seq}.md`],
    source_hashes: [`h${seq}`],
    prompt_hash: `prompt-${seq}`,
    model_id: "claude-haiku-4-5",
    response_hash: `resp-${seq}`,
    wiki_files_written: [`wiki/concepts/foo-${seq}.md`],
    wiki_file_hashes_after: { [`wiki/concepts/foo-${seq}.md`]: `feed${seq}` },
  };
}

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-g5-bench-")), "chain.jsonl");
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1);
  return sorted[idx]!;
}

async function timeAppends(chain: ProvenanceChain): Promise<number[]> {
  const timings: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = performance.now();
    await chain.append(makeInput(i));
    timings.push(performance.now() - t0);
  }
  return timings.sort((a, b) => a - b);
}

describe("G5 benchmark: HMAC overhead per append", () => {
  it(`p99 added latency < ${P99_BUDGET_MS}ms (KeyStore-attested vs baseline)`, async () => {
    // Baseline: no HMAC. Plain id + chain_hash only.
    const baselineChain = new ProvenanceChain({ path: tmpPath() });
    await baselineChain.init();
    const baselineTimings = await timeAppends(baselineChain);

    // Attested: KeyStore-backed HMAC on every append.
    const keyStore = new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
    keyStore.provision(WS);
    const attestedChain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await attestedChain.init();
    const attestedTimings = await timeAppends(attestedChain);

    const baselineP99 = percentile(baselineTimings, 0.99);
    const attestedP99 = percentile(attestedTimings, 0.99);
    const baselineP50 = percentile(baselineTimings, 0.5);
    const attestedP50 = percentile(attestedTimings, 0.5);
    const baselineP95 = percentile(baselineTimings, 0.95);
    const attestedP95 = percentile(attestedTimings, 0.95);
    const overheadP99 = attestedP99 - baselineP99;
    const overheadP50 = attestedP50 - baselineP50;

    // Emit a closure-doc-friendly summary on stdout for visibility.
    // Using fixed digits to keep the table aligned in the output capture.
    process.stdout.write(
      `\n[G5 HMAC overhead benchmark — Pass 018]\n` +
        `  iterations: ${ITERATIONS}\n` +
        `  baseline:   p50=${baselineP50.toFixed(3)}ms  p95=${baselineP95.toFixed(3)}ms  p99=${baselineP99.toFixed(3)}ms\n` +
        `  attested:   p50=${attestedP50.toFixed(3)}ms  p95=${attestedP95.toFixed(3)}ms  p99=${attestedP99.toFixed(3)}ms\n` +
        `  overhead:   p50=${overheadP50.toFixed(3)}ms  p99=${overheadP99.toFixed(3)}ms\n` +
        `  budget:     p99 < ${P99_BUDGET_MS.toFixed(1)}ms\n`,
    );

    expect(overheadP99).toBeLessThan(P99_BUDGET_MS);
  });
});
