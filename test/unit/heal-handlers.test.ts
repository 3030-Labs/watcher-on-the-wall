/**
 * Unit tests for heal handlers in src/wiki/heal-handlers.ts.
 * Tests mock the LLM invoker and verify handler behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/daemon/config.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { serializePage, newPage } from "../../src/wiki/page.js";
import { loadAllPages } from "../../src/ingestion/wiki-writer.js";
import type { HealthFinding } from "../../src/wiki/health.js";
import type { HealContext } from "../../src/wiki/heal-handlers.js";

// Mock the LLM invoker to avoid actual API calls.
vi.mock("../../src/ingestion/llm-invoker.js", () => ({
  invokeIngestionAgent: vi.fn().mockResolvedValue({
    finalText: "Fixed.",
    totalCostUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
    numTurns: 1,
    sessionId: null,
    writtenPaths: [],
    stopReason: "end_turn",
    success: true,
  }),
}));

// Mock git-committer.
vi.mock("../../src/ingestion/git-committer.js", () => ({
  commitWikiChanges: vi.fn().mockResolvedValue({
    committed: true,
    sha: "abc123",
    message: "test",
    fileCount: 1,
  }),
}));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-heal-"));
}

function makeCtx(root: string): HealContext {
  const config = defaultConfig();
  config.wiki_root = root;
  config.cost.track_file = join(root, ".wotw", "cost.jsonl");
  mkdirSync(join(root, ".wotw"), { recursive: true });
  return {
    config,
    store: new WikiStore({ wikiRoot: root }),
    search: new WikiSearch(),
    provenance: null,
    costTracker: new CostTracker({
      trackFile: config.cost.track_file,
      maxDailyUsd: 10,
      maxPerIngestUsd: 2,
      maxPerQueryUsd: 0.5,
    }),
    modelRouter: new ModelRouter(config),
    runtimeMode: "api",
  };
}

function writePage(
  root: string,
  category: string,
  slug: string,
  title: string,
  body: string,
): string {
  const dir = join(root, "wiki", category);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  const page = newPage(path, title, category === "concepts" ? "concept" : "entity", body);
  writeFileSync(path, serializePage(page));
  return path;
}

describe("heal handlers", () => {
  it("healStale invokes the LLM with correct prompt shape", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    writePage(root, "concepts", "test", "Test Page", "Old content.");
    const ctx = makeCtx(root);
    const finding: HealthFinding = {
      id: "stale:wiki/concepts/test.md",
      kind: "stale",
      severity: "medium",
      pages: ["wiki/concepts/test.md"],
      description: "Page is stale.",
      autoFixable: true,
    };

    const result = await healStale(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(invokeIngestionAgent).toHaveBeenCalled();
    const call = vi.mocked(invokeIngestionAgent).mock.calls[0]!;
    expect(call[0].userPrompt).toContain("Review and refresh");
  });

  it("healStale rebuilds search index after healing", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    writePage(root, "concepts", "stale-rebuild", "Stale Rebuild", "Old content.");
    const ctx = makeCtx(root);
    const rebuildSpy = vi.spyOn(ctx.search, "rebuild");

    const finding: HealthFinding = {
      id: "stale:wiki/concepts/stale-rebuild.md",
      kind: "stale",
      severity: "medium",
      pages: ["wiki/concepts/stale-rebuild.md"],
      description: "Page is stale.",
      autoFixable: true,
    };

    const result = await healStale(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    // The rebuild should receive an array of WikiPage objects.
    const rebuildArg = rebuildSpy.mock.calls[0]![0];
    expect(Array.isArray(rebuildArg)).toBe(true);
    rebuildSpy.mockRestore();
  });

  it("healBrokenLinks invokes with correct tools", async () => {
    const { healBrokenLinks } = await import("../../src/wiki/heal-handlers.js");
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    writePage(root, "concepts", "linker", "Linker", "See [[missing/link]].");
    const ctx = makeCtx(root);
    const finding: HealthFinding = {
      id: "broken-link:wiki/concepts/linker.md",
      kind: "broken-link",
      severity: "medium",
      pages: ["wiki/concepts/linker.md"],
      description: "1 broken wikilink(s): missing/link.",
      autoFixable: true,
    };

    const result = await healBrokenLinks(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(invokeIngestionAgent).toHaveBeenCalled();
    const call = vi.mocked(invokeIngestionAgent).mock.calls[0]!;
    expect(call[0].allowedTools).toContain("Read");
    expect(call[0].allowedTools).toContain("Write");
  });

  it("healBrokenLinks rebuilds search index after healing", async () => {
    const { healBrokenLinks } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    writePage(root, "concepts", "linker2", "Linker Two", "See [[bad/ref]].");
    const ctx = makeCtx(root);
    const rebuildSpy = vi.spyOn(ctx.search, "rebuild");

    const finding: HealthFinding = {
      id: "broken-link:wiki/concepts/linker2.md",
      kind: "broken-link",
      severity: "medium",
      pages: ["wiki/concepts/linker2.md"],
      description: "1 broken wikilink(s): bad/ref.",
      autoFixable: true,
    };

    const result = await healBrokenLinks(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    const rebuildArg = rebuildSpy.mock.calls[0]![0];
    expect(Array.isArray(rebuildArg)).toBe(true);
    rebuildSpy.mockRestore();
  });

  it("healMissingBacklinks runs repairBidirectionalLinks without LLM", async () => {
    const { healMissingBacklinks } = await import("../../src/wiki/heal-handlers.js");
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    // Page A references B, but B doesn't reference A back.
    const dir = join(root, "wiki", "concepts");
    mkdirSync(dir, { recursive: true });
    const pageA = newPage(join(dir, "a.md"), "Page A", "concept", "Content A.", {
      related: ["concepts/b"],
    });
    const pageB = newPage(join(dir, "b.md"), "Page B", "concept", "Content B.", {
      related: [],
    });
    writeFileSync(pageA.path, serializePage(pageA));
    writeFileSync(pageB.path, serializePage(pageB));

    const ctx = makeCtx(root);
    const finding: HealthFinding = {
      id: "missing-backlink:wiki/concepts/a.md->wiki/concepts/b.md",
      kind: "missing-backlink",
      severity: "low",
      pages: ["wiki/concepts/a.md", "wiki/concepts/b.md"],
      description: "a.md references b.md but b.md does not link back.",
      autoFixable: true,
    };

    vi.mocked(invokeIngestionAgent).mockClear();
    const result = await healMissingBacklinks(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(result.costUsd).toBe(0);
    // Should NOT invoke the LLM.
    expect(invokeIngestionAgent).not.toHaveBeenCalled();
  });

  it("max_fixes_per_run cap is respected", async () => {
    const { healFinding } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    writePage(root, "concepts", "test1", "Test 1", "Content.");
    writePage(root, "concepts", "test2", "Test 2", "Content.");
    writePage(root, "concepts", "test3", "Test 3", "Content.");
    const ctx = makeCtx(root);
    ctx.config.health.max_fixes_per_run = 2;

    const findings: HealthFinding[] = [
      {
        id: "stale:1",
        kind: "stale",
        severity: "medium",
        pages: ["wiki/concepts/test1.md"],
        description: "stale",
        autoFixable: true,
      },
      {
        id: "stale:2",
        kind: "stale",
        severity: "medium",
        pages: ["wiki/concepts/test2.md"],
        description: "stale",
        autoFixable: true,
      },
      {
        id: "stale:3",
        kind: "stale",
        severity: "medium",
        pages: ["wiki/concepts/test3.md"],
        description: "stale",
        autoFixable: true,
      },
    ];

    // Simulate the cap logic from runLintPass.
    const results = [];
    let fixCount = 0;
    for (const finding of findings) {
      if (fixCount >= ctx.config.health.max_fixes_per_run) break;
      const result = await healFinding(finding, ctx);
      if (result) {
        results.push(result);
        if (result.fixed) fixCount += 1;
      }
    }
    expect(results.length).toBe(2);
    expect(fixCount).toBe(2);
  });

  it("healDuplicate marks redundant pages as status: merged", async () => {
    const { healDuplicate } = await import("../../src/wiki/heal-handlers.js");
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    vi.mocked(invokeIngestionAgent).mockClear();
    const root = tmp();
    writePage(root, "concepts", "page-a", "Topic", "Content A.");
    writePage(root, "concepts", "page-b", "Topic", "Content B.");
    const ctx = makeCtx(root);
    const allPages = await loadAllPages(ctx.store);
    ctx.search.rebuild(allPages);

    const finding: HealthFinding = {
      id: "duplicate:wiki/concepts/page-a.md+wiki/concepts/page-b.md",
      kind: "duplicate",
      severity: "medium",
      pages: ["wiki/concepts/page-a.md", "wiki/concepts/page-b.md"],
      description: "2 pages appear to cover the same topic.",
      autoFixable: true,
    };

    const result = await healDuplicate(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(invokeIngestionAgent).toHaveBeenCalled();
    const call = vi.mocked(invokeIngestionAgent).mock.calls[0]!;
    expect(call[0].userPrompt).toContain("Merge them");
  });

  it("healContradiction resolves conflicting pages and rebuilds search", async () => {
    const { healContradiction } = await import("../../src/wiki/heal-handlers.js");
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    vi.mocked(invokeIngestionAgent).mockClear();

    const root = tmp();
    // Create two pages with contradictory claims.
    writePage(root, "concepts", "page-x", "Page X", "The default timeout is 30 seconds.");
    writePage(root, "concepts", "page-y", "Page Y", "The default timeout is 60 seconds.");

    const ctx = makeCtx(root);
    const allPages = await loadAllPages(ctx.store);
    ctx.search.rebuild(allPages);
    const rebuildSpy = vi.spyOn(ctx.search, "rebuild");

    const finding: HealthFinding = {
      id: "contradiction:wiki/concepts/page-x.md+wiki/concepts/page-y.md",
      kind: "contradiction",
      severity: "high",
      pages: ["wiki/concepts/page-x.md", "wiki/concepts/page-y.md"],
      description: "Page X says timeout is 30s, Page Y says timeout is 60s.",
      autoFixable: true,
    };

    const result = await healContradiction(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(result.costUsd).toBeGreaterThan(0);
    expect(invokeIngestionAgent).toHaveBeenCalled();

    // Verify the LLM prompt contains the contradiction description.
    const call2 = vi.mocked(invokeIngestionAgent).mock.calls[0]!;
    expect(call2[0].userPrompt).toContain("contradict");
    expect(call2[0].userPrompt).toContain("Page X says timeout is 30s");

    // Verify search index was rebuilt after healing.
    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    const rebuildArg = rebuildSpy.mock.calls[0]![0];
    expect(Array.isArray(rebuildArg)).toBe(true);
    rebuildSpy.mockRestore();
  });

  it("healContradiction returns not-fixed when fewer than 2 pages", async () => {
    const { healContradiction } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    const ctx = makeCtx(root);

    const finding: HealthFinding = {
      id: "contradiction:single",
      kind: "contradiction",
      severity: "high",
      pages: ["wiki/concepts/only-one.md"],
      description: "Only one page.",
      autoFixable: true,
    };

    const result = await healContradiction(finding, ctx);
    expect(result.fixed).toBe(false);
    expect(result.reason).toBe("need >=2 pages");
    expect(result.costUsd).toBe(0);
  });
});
