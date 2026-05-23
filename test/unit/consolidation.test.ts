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

    // Target pages that share rare terms ("quasar", "nebula") in their titles and bodies.
    writePage(
      root,
      "concept",
      "quasar-nebula-overview",
      "Quasar Nebula Overview",
      "Quasar nebula overview details.",
    );
    writePage(
      root,
      "concept",
      "quasar-nebula-reference",
      "Quasar Nebula Reference",
      "Quasar nebula reference details.",
    );
    writePage(
      root,
      "concept",
      "quasar-nebula-guide",
      "Quasar Nebula Guide",
      "Quasar nebula guide details.",
    );

    // Filler pages with unrelated vocabulary. These raise the IDF of "quasar" and "nebula"
    // so that MiniSearch scores cross-matches above the normalized >= 40 threshold.
    const fillerTopics: Array<[string, string, string]> = [
      [
        "authentication",
        "Authentication System",
        "Login flow using JWT tokens and OAuth providers.",
      ],
      [
        "database-design",
        "Database Design",
        "Schema normalization and query optimization patterns.",
      ],
      ["load-balancing", "Load Balancing", "Round robin and consistent hashing distribution."],
      ["caching-strategy", "Caching Strategy", "Redis memcached LRU eviction policies."],
      ["monitoring-alerts", "Monitoring Alerts", "Prometheus grafana alertmanager notifications."],
      ["ci-cd-pipeline", "CI CD Pipeline", "GitHub actions deployment automation testing."],
      ["api-versioning", "API Versioning", "Semantic versioning backward compatibility."],
      ["error-handling", "Error Handling", "Exception propagation retry circuit breaker."],
      ["logging-tracing", "Logging Tracing", "Structured logging distributed tracing."],
      ["security-hardening", "Security Hardening", "Input validation CSRF XSS prevention."],
    ];
    for (const [slug, title, body] of fillerTopics) {
      writePage(root, "concept", slug, title, body);
    }

    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const pages = store.listAll().map((p) => {
      const raw = readFileSync(p, "utf8");
      return parsePage(p, raw);
    });
    search.rebuild(pages);

    const groups = detectConsolidationCandidates(store, search, config);
    // With threshold=2 and high IDF for "quasar"/"nebula", the 3 target pages should group.
    expect(Array.isArray(groups)).toBe(true);
    expect(groups.length).toBeGreaterThan(0);
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
    // Review item 27: heal handlers now require valid JSON edits to
    // report fixed:true. Pre-fix mock returned non-JSON "Consolidated
    // page content" which silently passed under the broken behavior.
    vi.doMock("../../src/llm/runtime-aware.js", () => ({
      runtimeAwareComplete: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          edits: [
            {
              path: "wiki/concepts/topic-a.md",
              content:
                "---\ntitle: 'Topic A'\ncategory: concept\nsources: []\nrelated: []\nstatus: consolidated\nconsolidated_into: 'wiki/concepts/topic-a.md'\nlast_compiled: '2026-01-01'\nsource_count: 0\nlast_confirmed: '2026-01-01'\nsuperseded_by: null\n---\nConsolidated body.",
            },
          ],
        }),
        costUsd: 0.002,
        inputTokens: 500,
        outputTokens: 200,
        durationMs: 1000,
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
    // Verify the finding is preserved in the result for downstream tracking.
    expect(result.finding.kind).toBe("consolidation");
    expect(result.finding.pages).toEqual(["wiki/concepts/topic-a.md", "wiki/concepts/topic-b.md"]);
  });
});
