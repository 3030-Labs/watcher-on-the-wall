/**
 * Regression test for CRITICAL-8: empty batch guard in IngestionQueue.
 *
 * When the LLM agent produces zero wiki pages (and zero skipped writes),
 * the queue must mark the outcome as skipped with reason
 * "agent produced no wiki pages" and skip all downstream work (cross-ref,
 * index rebuild, cost logging, git commit).
 *
 * Strategy: We construct a real IngestionQueue with mocked dependencies.
 * The LLM invoker is mocked at the module level to return an InvokeResult
 * with zero writtenPaths. The WikiStore, IndexManager, WikiSearch,
 * CostTracker, and ModelRouter are stubbed with minimal implementations.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IngestionQueue, type IngestionQueueOptions } from "../../src/ingestion/queue.js";
import type { WatcherBatch } from "../../src/watcher/index.js";
import { defaultConfig } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

// Mock the LLM invoker so we never call a real LLM
vi.mock("../../src/ingestion/llm-invoker.js", () => ({
  invokeIngestionAgent: vi.fn(),
}));

// Mock the prompt builder so we skip filesystem reads
vi.mock("../../src/ingestion/prompt-builder.js", () => ({
  buildIngestionPrompt: vi.fn().mockResolvedValue({
    system: "test system prompt",
    text: "test user prompt",
  }),
}));

// Mock git committer so we skip git operations
vi.mock("../../src/ingestion/git-committer.js", () => ({
  commitWikiChanges: vi.fn().mockResolvedValue({ sha: null }),
}));

// Mock cross-reference repair
vi.mock("../../src/wiki/cross-reference.js", () => ({
  repairBidirectionalLinks: vi.fn().mockReturnValue([]),
}));

// Mock provenance hash functions
vi.mock("../../src/provenance/hash.js", () => ({
  sha256File: vi.fn().mockResolvedValue("fakehash"),
  sha256Files: vi.fn().mockResolvedValue({}),
  sha256Hex: vi.fn().mockReturnValue("fakehexhash"),
}));

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-queue-"));
}

function testConfig(wikiRoot: string): WotwConfig {
  const cfg = defaultConfig();
  cfg.wiki_root = wikiRoot;
  cfg.raw_path = join(wikiRoot, "raw");
  return cfg;
}

function makeBatch(paths: string[]): WatcherBatch {
  return {
    id: "batch-test-empty",
    createdAt: new Date().toISOString(),
    paths,
    reasons: Object.fromEntries(paths.map((p) => [p, "update" as const])),
    deletedPaths: [],
  };
}

/**
 * Build a minimal set of stubs for the IngestionQueue dependencies.
 */
function buildOpts(wikiRoot: string): IngestionQueueOptions {
  const wikiDir = join(wikiRoot, "wiki");
  mkdirSync(wikiDir, { recursive: true });
  // Create category subdirs so store.ensureLayout doesn't fail
  for (const cat of [
    "concepts",
    "entities",
    "sources",
    "comparisons",
    "syntheses",
    "queries",
    "candidates",
  ]) {
    mkdirSync(join(wikiDir, cat), { recursive: true });
  }

  return {
    config: testConfig(wikiRoot),
    store: {
      wikiDir,
      candidatesDir: join(wikiDir, "candidates"),
      ensureLayout: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockReturnValue([]),
      readPage: vi.fn().mockResolvedValue(null),
      writePage: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    indexManager: {
      rebuild: vi.fn().mockResolvedValue(undefined),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    search: {
      rebuild: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    costTracker: {
      wouldExceedDaily: vi.fn().mockReturnValue(false),
      logUsage: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    modelRouter: {
      modelFor: vi.fn().mockReturnValue("claude-haiku-4-5"),
      computeCost: vi.fn().mockReturnValue(0.001),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    runtimeMode: "api",
  };
}

describe("IngestionQueue empty batch guard (CRITICAL-8)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks outcome as skipped when agent produces zero wiki pages", async () => {
    const dir = tmpDir();
    const wikiRoot = join(dir, "project");
    mkdirSync(wikiRoot, { recursive: true });

    const rawDir = join(wikiRoot, "raw");
    mkdirSync(rawDir, { recursive: true });

    const opts = buildOpts(wikiRoot);
    const queue = new IngestionQueue(opts);
    await queue.start();

    // Set up the LLM invoker mock to return zero written paths
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    (invokeIngestionAgent as ReturnType<typeof vi.fn>).mockResolvedValue({
      finalText: "I didn't write anything",
      totalCostUsd: 0.002,
      inputTokens: 500,
      outputTokens: 100,
      durationMs: 1000,
      numTurns: 1,
      sessionId: null,
      writtenPaths: [], // No paths written by the agent
      stopReason: "end_turn",
      success: true,
    });

    // Create a dummy source file path
    const sourceFile = join(rawDir, "test-source.md");

    const batch = makeBatch([sourceFile]);
    const outcome = await queue.enqueue(batch);

    expect(outcome.skipped).toBe(true);
    expect(outcome.skipReason).toBe("agent produced no wiki pages");
    expect(outcome.pagesWritten).toBe(0);
    expect(outcome.batchId).toBe("batch-test-empty");

    // Cost should still be tracked (the LLM was invoked even though it produced nothing)
    expect(outcome.costUsd).toBe(0.002);

    // Git commit should NOT have been called since we short-circuit
    const { commitWikiChanges } = await import("../../src/ingestion/git-committer.js");
    expect(commitWikiChanges).not.toHaveBeenCalled();

    await queue.stop();
  });
});
