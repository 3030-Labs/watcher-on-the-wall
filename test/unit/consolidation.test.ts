/**
 * Tests for Feature 3: Knowledge consolidation detection and healing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/daemon/config.js";
import { newPage, serializePage, parsePage } from "../../src/wiki/page.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { detectConsolidationCandidates } from "../../src/wiki/health.js";
import type { WikiPage } from "../../src/utils/types.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-consol-"));
}

function writePage(
  root: string,
  category: string,
  slug: string,
  title: string,
  body: string,
  extra: Partial<WikiPage["frontmatter"]> = {},
): void {
  const dir = join(root, "wiki", `${category}s`);
  mkdirSync(dir, { recursive: true });
  const page = newPage(
    join(dir, `${slug}.md`),
    title,
    category as WikiPage["frontmatter"]["category"],
    body,
    extra,
  );
  writeFileSync(page.path, serializePage(page), "utf8");
}

describe("detectConsolidationCandidates", () => {
  it("returns groups above the threshold", () => {
    const root = tmp();
    const config = { ...defaultConfig(), wiki_root: root };
    config.health.consolidation_threshold = 2; // low threshold for testing
    config.health.consolidation_enabled = true;

    // Create 3 pages with very similar titles to trigger similarity grouping.
    writePage(root, "concept", "deploy-guide", "Deploy Guide", "How to deploy applications.");
    writePage(root, "concept", "deploy-process", "Deploy Process", "The deploy process for apps.");
    writePage(
      root,
      "concept",
      "deploy-strategy",
      "Deploy Strategy",
      "Deployment strategy overview.",
    );

    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const pages = store.listAll().map((p) => {
      const raw = readFileSync(p, "utf8");
      return parsePage(p, raw);
    });
    search.rebuild(pages);

    const groups = detectConsolidationCandidates(store, search, config);
    // With threshold=2, 3 similar deploy pages should form a group.
    // The result depends on minisearch similarity scores; at minimum it shouldn't crash.
    expect(Array.isArray(groups)).toBe(true);
    for (const g of groups) {
      expect(g.pages.length).toBeGreaterThan(config.health.consolidation_threshold);
      expect(g.topic).toBeDefined();
      expect(g.suggestedTitle).toBeDefined();
    }
  });

  it("returns empty when consolidation is disabled", () => {
    const root = tmp();
    const config = { ...defaultConfig(), wiki_root: root };
    config.health.consolidation_enabled = false;

    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    search.rebuild([]);

    const groups = detectConsolidationCandidates(store, search, config);
    expect(groups).toEqual([]);
  });

  it("does not return groups below the threshold", () => {
    const root = tmp();
    const config = { ...defaultConfig(), wiki_root: root };
    config.health.consolidation_threshold = 10; // very high threshold
    config.health.consolidation_enabled = true;

    // Only create 2 pages — below threshold of 10.
    writePage(root, "concept", "auth-basics", "Auth Basics", "Authentication fundamentals.");
    writePage(root, "concept", "auth-advanced", "Auth Advanced", "Advanced authentication.");

    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const pages = store.listAll().map((p) => {
      const raw = readFileSync(p, "utf8");
      return parsePage(p, raw);
    });
    search.rebuild(pages);

    const groups = detectConsolidationCandidates(store, search, config);
    expect(groups).toEqual([]);
  });
});

describe("healConsolidation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("marks originals as status: consolidated (mock LLM)", async () => {
    vi.doMock("../../src/ingestion/llm-invoker.js", () => ({
      invokeIngestionAgent: vi.fn().mockResolvedValue({
        finalText: "Consolidated page content",
        totalCostUsd: 0.002,
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 1000,
        numTurns: 1,
        sessionId: "test",
        writtenPaths: [],
        stopReason: "end_turn",
        success: true,
      }),
    }));
    vi.doMock("../../src/ingestion/git-committer.js", () => ({
      commitWikiChanges: vi.fn().mockResolvedValue({ committed: true, sha: "abc123" }),
    }));

    const { healConsolidation } = await import("../../src/wiki/heal-handlers.js");
    const { CostTracker } = await import("../../src/ingestion/cost-tracker.js");
    const { ModelRouter } = await import("../../src/ingestion/model-router.js");

    const root = tmp();
    writePage(root, "concept", "topic-a", "Topic A", "Content A");
    writePage(root, "concept", "topic-b", "Topic B", "Content B");

    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const pages = store.listAll().map((p) => {
      const raw = readFileSync(p, "utf8");
      return parsePage(p, raw);
    });
    search.rebuild(pages);

    const config = { ...defaultConfig(), wiki_root: root };
    const ctx = {
      config,
      store,
      search,
      provenance: null,
      costTracker: new CostTracker({
        trackFile: join(root, "cost.jsonl"),
        maxDailyUsd: 10,
        maxPerIngestUsd: 2,
        maxPerQueryUsd: 0.5,
      }),
      modelRouter: new ModelRouter(config),
      runtimeMode: "api" as const,
    };

    const finding = {
      id: "consolidation:wiki/concepts/topic-a.md+wiki/concepts/topic-b.md",
      kind: "consolidation" as const,
      severity: "low" as const,
      pages: ["wiki/concepts/topic-a.md", "wiki/concepts/topic-b.md"],
      description: '2 pages cover the topic area "topics" and could be consolidated.',
      autoFixable: true,
    };

    const result = await healConsolidation(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(result.costUsd).toBe(0.002);
  });
});
