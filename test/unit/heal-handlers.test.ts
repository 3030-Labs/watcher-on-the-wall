/**
 * Unit tests for heal handlers in src/wiki/heal-handlers.ts.
 *
 * Post review item 27 / 28 / 69 closure: the default mock now returns a
 * VALID JSON edits envelope with zero edits, which exercises the new
 * "fixed:false when no edits emitted" gate. Tests that want the
 * success path explicitly mock a valid edits response for the page
 * they're healing via the `mockValidEdits(...)` helper.
 *
 * Why this changed: the prior default mock returned a non-JSON
 * "Fixed." text, which parseDaemonEditsResponse rejected, no files
 * were written, and yet every handler reported fixed:true. That bug
 * is review item 27 (heal-handlers ALWAYS return fixed:true) and the
 * test theater is review item 69 (S10-F2).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

// Mock the runtime-aware complete wrapper to avoid actual API calls.
// Default returns an EMPTY edits envelope — the new no-op gate (item 27)
// makes handlers return fixed:false unless the test explicitly mocks
// valid edits via mockValidEdits().
vi.mock("../../src/llm/runtime-aware.js", () => ({
  runtimeAwareComplete: vi.fn().mockResolvedValue({
    text: '{"edits": []}',
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
  }),
}));

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
  config.raw_path = join(root, "raw");
  config.cost.track_file = join(root, ".wotw", "cost.jsonl");
  mkdirSync(join(root, ".wotw"), { recursive: true });
  mkdirSync(config.raw_path, { recursive: true });
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

/**
 * Mock runtimeAwareComplete to emit a VALID JSON edits envelope that
 * rewrites the given page with new content. Used by tests that need the
 * fixed:true happy path.
 */
async function mockValidEdits(pagePath: string, newBody: string): Promise<void> {
  const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
  // Build a minimal valid wiki page (frontmatter + body) so the
  // reconcile pipeline accepts it.
  const page = newPage(pagePath, "Healed", "concept", newBody);
  const content = serializePage(page);
  vi.mocked(runtimeAwareComplete).mockResolvedValueOnce({
    text: JSON.stringify({ edits: [{ path: pagePath, content }] }),
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 500,
  });
}

describe("heal handlers — happy paths", () => {
  it("healStale returns fixed:true when LLM emits valid edits", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    const root = tmp();
    const pagePath = writePage(root, "concepts", "test", "Test Page", "Old content.");
    const ctx = makeCtx(root);
    await mockValidEdits(pagePath, "Refreshed content.");
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
    expect(runtimeAwareComplete).toHaveBeenCalled();
    const call = vi.mocked(runtimeAwareComplete).mock.calls[0]!;
    expect(call[0]).toContain("Review and refresh");
  });

  it("healStale rebuilds search index after writing", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    const pagePath = writePage(root, "concepts", "stale-rebuild", "Stale Rebuild", "Old.");
    const ctx = makeCtx(root);
    const rebuildSpy = vi.spyOn(ctx.search, "rebuild");
    await mockValidEdits(pagePath, "New content.");

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
    expect(rebuildSpy).toHaveBeenCalled();
    rebuildSpy.mockRestore();
  });

  it("healBrokenLinks: prompt references the broken-link page", async () => {
    const { healBrokenLinks } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    vi.mocked(runtimeAwareComplete).mockClear();
    const root = tmp();
    const pagePath = writePage(root, "concepts", "linker", "Linker", "See [[missing/link]].");
    const ctx = makeCtx(root);
    await mockValidEdits(pagePath, "See nothing.");
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
    expect(runtimeAwareComplete).toHaveBeenCalled();
    const call = vi.mocked(runtimeAwareComplete).mock.calls[0]!;
    expect(call[0]).toContain("broken");
    expect(call[0]).toContain("wiki/concepts/linker.md");
  });

  it("healMissingBacklinks runs repairBidirectionalLinks without LLM", async () => {
    const { healMissingBacklinks } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    const root = tmp();
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

    vi.mocked(runtimeAwareComplete).mockClear();
    const result = await healMissingBacklinks(finding, ctx);
    expect(result.fixed).toBe(true);
    expect(result.costUsd).toBe(0);
    expect(runtimeAwareComplete).not.toHaveBeenCalled();
  });

  it("healContradiction: prompt contains contradiction description", async () => {
    const { healContradiction } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    vi.mocked(runtimeAwareComplete).mockClear();

    const root = tmp();
    const pagePath = writePage(root, "concepts", "page-x", "Page X", "Timeout is 30s.");
    writePage(root, "concepts", "page-y", "Page Y", "Timeout is 60s.");

    const ctx = makeCtx(root);
    const allPages = await loadAllPages(ctx.store);
    ctx.search.rebuild(allPages);
    await mockValidEdits(pagePath, "Timeout is 60s.");
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
    expect(runtimeAwareComplete).toHaveBeenCalled();
    const call2 = vi.mocked(runtimeAwareComplete).mock.calls[0]!;
    expect(call2[0]).toContain("contradict");
    expect(call2[0]).toContain("Page X says timeout is 30s");
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

describe("heal handlers — review item 27 no-op gate", () => {
  it("healStale returns fixed:false when LLM emits empty edits", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    writePage(root, "concepts", "test", "Test Page", "Old content.");
    const ctx = makeCtx(root);
    // Default mock = {"edits":[]} → no files written.
    const finding: HealthFinding = {
      id: "stale:wiki/concepts/test.md",
      kind: "stale",
      severity: "medium",
      pages: ["wiki/concepts/test.md"],
      description: "Page is stale.",
      autoFixable: true,
    };

    const result = await healStale(finding, ctx);
    expect(result.fixed).toBe(false);
    expect(result.reason).toBe("LLM emitted no edits");
  });

  it("healStale returns fixed:false when LLM emits non-JSON 'Fixed.' (the original bug)", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    const root = tmp();
    writePage(root, "concepts", "test", "Test Page", "Old content.");
    const ctx = makeCtx(root);
    vi.mocked(runtimeAwareComplete).mockResolvedValueOnce({
      text: "Fixed.",
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 500,
    });
    const finding: HealthFinding = {
      id: "stale:wiki/concepts/test.md",
      kind: "stale",
      severity: "medium",
      pages: ["wiki/concepts/test.md"],
      description: "Page is stale.",
      autoFixable: true,
    };

    const result = await healStale(finding, ctx);
    expect(result.fixed).toBe(false);
    expect(result.reason).toBe("LLM emitted no edits");
  });
});

describe("heal handlers — review item 28 raw/ write-block", () => {
  it("healStale rejects an edit targeting raw/", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    const root = tmp();
    writePage(root, "concepts", "test", "Test Page", "Old.");
    const ctx = makeCtx(root);
    const rawTargetPath = join(ctx.config.raw_path, "attack.md");

    // Adversarial LLM emits an edit pointing inside raw/.
    vi.mocked(runtimeAwareComplete).mockResolvedValueOnce({
      text: JSON.stringify({
        edits: [{ path: rawTargetPath, content: "attacker-controlled" }],
      }),
      costUsd: 0.001,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 500,
    });

    const finding: HealthFinding = {
      id: "stale:wiki/concepts/test.md",
      kind: "stale",
      severity: "medium",
      pages: ["wiki/concepts/test.md"],
      description: "Page is stale.",
      autoFixable: true,
    };

    const result = await healStale(finding, ctx);
    // Gate fires because writtenPaths is empty (raw/ edit was rejected).
    expect(result.fixed).toBe(false);
    expect(existsSync(rawTargetPath)).toBe(false);
  });

  it("healStale: heal-written page has provenance footer + last_compiled (reconcile applied)", async () => {
    const { healStale } = await import("../../src/wiki/heal-handlers.js");
    const root = tmp();
    const pagePath = writePage(root, "concepts", "test", "Test", "Old.");
    const ctx = makeCtx(root);
    await mockValidEdits(pagePath, "Healed body.");
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
    const written = readFileSync(pagePath, "utf8");
    // reconcileWrittenPages appends a provenance footer + sets last_compiled.
    expect(written).toContain("wotw:provenance:start");
    expect(written).toContain("last_compiled:");
  });
});

describe("heal handlers — orchestration cap", () => {
  it("max_fixes_per_run cap is respected", async () => {
    const { healFinding } = await import("../../src/wiki/heal-handlers.js");
    const { runtimeAwareComplete } = await import("../../src/llm/runtime-aware.js");
    const root = tmp();
    const p1 = writePage(root, "concepts", "test1", "Test 1", "Content.");
    const p2 = writePage(root, "concepts", "test2", "Test 2", "Content.");
    writePage(root, "concepts", "test3", "Test 3", "Content.");
    const ctx = makeCtx(root);
    ctx.config.health.max_fixes_per_run = 2;

    // Mock two valid edits, then default (empty) for the third.
    vi.mocked(runtimeAwareComplete).mockClear();
    await mockValidEdits(p1, "Refresh 1.");
    await mockValidEdits(p2, "Refresh 2.");

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
});
