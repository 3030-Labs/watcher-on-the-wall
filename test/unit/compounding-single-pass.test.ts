/**
 * Phase 4 — compounding/engine single-pass refactor regression tests.
 *
 * Verifies that CompoundingEngine.synthesize():
 *   1. Dispatches through runtimeAwareComplete (NOT invokeIngestionAgent)
 *   2. Pre-assembles full source page bodies into the prompt
 *   3. Daemon assembles frontmatter from cluster metadata (model returns
 *      body markdown only)
 *   4. Writes synthesis page via WikiStore.writePage atomically
 *   5. Defensive stripFrontmatterIfPresent handles model-emitted frontmatter
 *   6. Source body truncation at 16KB cap with marker
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompoundingEngine } from "../../src/compounding/engine.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage, parsePage, serializePage } from "../../src/wiki/page.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";

vi.mock("../../src/llm/runtime-aware.js", () => ({
  runtimeAwareComplete: vi.fn(),
}));

vi.mock("../../src/ingestion/git-committer.js", () => ({
  commitWikiChanges: vi.fn().mockResolvedValue({
    committed: true,
    sha: "abc123",
    message: "test",
    fileCount: 1,
  }),
}));

import { runtimeAwareComplete } from "../../src/llm/runtime-aware.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-cs-"));
}

function writePage(
  root: string,
  category: string,
  slug: string,
  title: string,
  body: string,
  tags: string[] = [],
): string {
  mkdirSync(join(root, "wiki", category), { recursive: true });
  const absPath = join(root, "wiki", category, `${slug}.md`);
  const page = newPage(absPath, title, "concept", body, { tags });
  writeFileSync(absPath, serializePage(page));
  return absPath;
}

async function makeRig(): Promise<{
  engine: CompoundingEngine;
  store: WikiStore;
  root: string;
}> {
  const root = tmpRoot();
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.compounding.enabled = true;
  cfg.compounding.min_source_pages = 3;
  const config = resolveConfigPaths(cfg);

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  await store.ensureLayout();
  const search = new WikiSearch();
  const indexManager = new IndexManager(store);
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: 10,
    maxPerIngestUsd: 5,
    maxPerQueryUsd: 1,
  });
  const modelRouter = new ModelRouter(config);

  const engine = new CompoundingEngine({
    config,
    store,
    indexManager,
    search,
    costTracker,
    modelRouter,
    runtimeMode: "api",
  });

  return { engine, store, root };
}

const mockedComplete = vi.mocked(runtimeAwareComplete);

describe("CompoundingEngine single-pass refactor (Phase 4)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pre-assembles source page bodies into the prompt and writes daemon-assembled synthesis", async () => {
    const { engine, root } = await makeRig();

    // Three pages sharing the "machine-learning" tag — clears min_source_pages.
    writePage(root, "concepts", "neural-nets", "Neural Networks", "DEEP_LEARNING_BODY_MARKER", [
      "machine-learning",
    ]);
    writePage(root, "concepts", "transformers", "Transformers", "ATTENTION_MECHANISM_MARKER", [
      "machine-learning",
    ]);
    writePage(root, "concepts", "embeddings", "Embeddings", "VECTOR_REPRESENTATION_MARKER", [
      "machine-learning",
    ]);

    mockedComplete.mockResolvedValueOnce({
      text: "Synthesis body discussing [[Neural Networks]] and [[Transformers]].",
      costUsd: 0.005,
      inputTokens: 1500,
      outputTokens: 200,
      durationMs: 800,
    });

    const result = await engine.synthesize();

    expect(mockedComplete).toHaveBeenCalledTimes(1);
    const [calledPrompt, calledOptions] = mockedComplete.mock.calls[0];

    // Source bodies appear in the prompt verbatim.
    expect(calledPrompt).toContain("DEEP_LEARNING_BODY_MARKER");
    expect(calledPrompt).toContain("ATTENTION_MECHANISM_MARKER");
    expect(calledPrompt).toContain("VECTOR_REPRESENTATION_MARKER");

    // Prompt explicitly forbids YAML frontmatter.
    expect(calledPrompt).toContain("no YAML frontmatter");

    // maxTokens hint forwarded.
    expect(calledOptions.maxTokens).toBe(8192);

    // Synthesis file was written.
    expect(result.skipped).toBe(false);
    expect(result.pagesWritten).toBe(1);
    expect(result.clusters.length).toBe(1);

    // Synthesis page exists and has daemon-assembled frontmatter.
    const synthesisPath = join(root, "wiki", "syntheses", "machine-learning.md");
    expect(existsSync(synthesisPath)).toBe(true);

    const rawSynthesis = readFileSync(synthesisPath, "utf8");
    const synthesis = parsePage(synthesisPath, rawSynthesis);
    expect(synthesis.frontmatter.title).toBe("machine-learning");
    expect(synthesis.frontmatter.category).toBe("synthesis");
    expect(synthesis.frontmatter.sources).toContain("wiki/concepts/neural-nets.md");
    expect(synthesis.frontmatter.sources).toContain("wiki/concepts/transformers.md");
    expect(synthesis.frontmatter.sources).toContain("wiki/concepts/embeddings.md");
    expect(synthesis.frontmatter.tags).toEqual(["machine-learning"]);
    expect(synthesis.body).toContain("[[Neural Networks]]");
  });

  it("strips model-emitted frontmatter if present (defensive)", async () => {
    const { engine, root } = await makeRig();
    writePage(root, "concepts", "a", "A", "BODY_A", ["taggy"]);
    writePage(root, "concepts", "b", "B", "BODY_B", ["taggy"]);
    writePage(root, "concepts", "c", "C", "BODY_C", ["taggy"]);

    // Model misbehaves and emits frontmatter despite instructions.
    mockedComplete.mockResolvedValueOnce({
      text: "---\ntitle: Bad Title\ncategory: synthesis\n---\n\nThe real synthesis body lives here.",
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 30,
      durationMs: 200,
    });

    const result = await engine.synthesize();
    expect(result.pagesWritten).toBe(1);

    const synthesisPath = join(root, "wiki", "syntheses", "taggy.md");
    const synthesis = parsePage(synthesisPath, readFileSync(synthesisPath, "utf8"));
    // Daemon-assembled frontmatter wins; model's "Bad Title" is stripped.
    expect(synthesis.frontmatter.title).toBe("taggy");
    expect(synthesis.body).toContain("The real synthesis body lives here.");
    // The bad frontmatter must NOT appear in the body.
    expect(synthesis.body).not.toContain("Bad Title");
  });

  it("truncates over-cap source bodies with a marker", async () => {
    const { engine, root } = await makeRig();
    const longBody = "x".repeat(20 * 1024) + " UNIQUE_POST_CAP_MARKER";
    writePage(root, "concepts", "big", "Big Page", longBody, ["bigcluster"]);
    writePage(root, "concepts", "small1", "Small 1", "SMALL_BODY_1", ["bigcluster"]);
    writePage(root, "concepts", "small2", "Small 2", "SMALL_BODY_2", ["bigcluster"]);

    mockedComplete.mockResolvedValueOnce({
      text: "synthesis",
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 10,
      durationMs: 100,
    });

    await engine.synthesize();

    const [calledPrompt] = mockedComplete.mock.calls[0];
    expect(calledPrompt).toContain("_[truncated]_");
    // Marker that's positioned AFTER the cap must not appear.
    expect(calledPrompt).not.toContain("UNIQUE_POST_CAP_MARKER");
    // Other (small) source bodies still present.
    expect(calledPrompt).toContain("SMALL_BODY_1");
    expect(calledPrompt).toContain("SMALL_BODY_2");
  });

  it("returns null writtenPath when model returns empty body", async () => {
    const { engine, root } = await makeRig();
    writePage(root, "concepts", "a", "A", "BODY_A", ["empty-cluster"]);
    writePage(root, "concepts", "b", "B", "BODY_B", ["empty-cluster"]);
    writePage(root, "concepts", "c", "C", "BODY_C", ["empty-cluster"]);

    mockedComplete.mockResolvedValueOnce({
      text: "",
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 0,
      durationMs: 100,
    });

    const result = await engine.synthesize();
    expect(result.pagesWritten).toBe(0);
    expect(result.clusters[0]?.synthesisPath).toBeNull();
    expect(result.clusters[0]?.reason).toContain("no synthesis");
  });

  it("does NOT import invokeIngestionAgent in compounding/engine.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const engineSource = readFileSync(
      join(here, "..", "..", "src", "compounding", "engine.ts"),
      "utf8",
    );
    expect(engineSource).not.toMatch(/^import .* invokeIngestionAgent .* from /m);
    expect(engineSource).toMatch(/^import .* runtimeAwareComplete .* from /m);
  });
});
