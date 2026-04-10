/**
 * Integration tests for computeHealthReport — exercises the full health
 * pipeline on a small test wiki with varying health conditions.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/daemon/config.js";
import { computeHealthReport } from "../../src/wiki/health.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { loadAllPages } from "../../src/ingestion/wiki-writer.js";
import { serializePage, newPage } from "../../src/wiki/page.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-health-report-"));
}

function writePage(
  root: string,
  category: string,
  slug: string,
  opts: {
    title: string;
    tags?: string[];
    body?: string;
    sources?: string[];
    related?: string[];
    status?: string;
  },
): string {
  const dir = join(root, "wiki", category);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  const page = newPage(
    path,
    opts.title,
    category === "concepts" ? "concept" : "entity",
    opts.body ?? "Content.",
    {
      tags: opts.tags ?? [],
      sources: opts.sources ?? [],
      related: opts.related ?? [],
    },
  );
  if (opts.status === "orphaned") {
    page.frontmatter.status = "orphaned";
    page.frontmatter.orphaned_at = new Date().toISOString();
  }
  writeFileSync(path, serializePage(page));
  return path;
}

describe("computeHealthReport — integration", () => {
  it("produces a complete report for a small wiki", async () => {
    const root = tmp();
    mkdirSync(join(root, "raw"), { recursive: true });

    // 1. Healthy page
    writePage(root, "concepts", "healthy", {
      title: "Healthy Page",
      tags: ["crypto", "hashing"],
      body: "This page is perfectly fine.",
    });

    // 2. Orphaned page
    writePage(root, "concepts", "orphaned-topic", {
      title: "Orphaned Topic",
      tags: ["old"],
      body: "Source was deleted.",
      status: "orphaned",
    });

    // 3. Page with broken links
    writePage(root, "entities", "linker", {
      title: "Page With Links",
      tags: ["links"],
      body: "See [[concepts/healthy]] and [[concepts/nonexistent]].",
    });

    // 4. Page with valid links
    writePage(root, "entities", "good-linker", {
      title: "Good Linker",
      tags: ["links"],
      body: "See [[concepts/healthy]].",
    });

    // 5. Standalone page
    writePage(root, "concepts", "standalone", {
      title: "Standalone",
      tags: ["solo"],
      body: "Nothing related.",
    });

    const config = defaultConfig();
    config.wiki_root = root;
    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    const allPages = await loadAllPages(store);
    search.rebuild(allPages);

    const report = await computeHealthReport(store, null, search, { config });

    // Basic structure checks.
    expect(report.timestamp).toBeTruthy();
    expect(report.scores.length).toBe(5); // all 5 pages scored
    expect(report.summary.total).toBeGreaterThanOrEqual(0);

    // Should detect orphan.
    const orphanFindings = report.findings.filter((f) => f.kind === "orphan");
    expect(orphanFindings.length).toBe(1);
    expect(orphanFindings[0]!.pages[0]).toContain("orphaned-topic");

    // Should detect broken link.
    const brokenLinkFindings = report.findings.filter((f) => f.kind === "broken-link");
    expect(brokenLinkFindings.length).toBeGreaterThanOrEqual(1);
    const linkerFinding = brokenLinkFindings.find((f) => f.pages[0]?.includes("linker"));
    expect(linkerFinding).toBeDefined();
    expect(linkerFinding!.description).toContain("nonexistent");

    // Summary counts match.
    expect(report.summary.total).toBe(report.findings.length);
    expect(report.summary.high + report.summary.medium + report.summary.low).toBe(
      report.summary.total,
    );
    expect(report.summary.autoFixable).toBe(report.findings.filter((f) => f.autoFixable).length);

    // Stale findings — since there's no provenance, all pages have staleness=0
    // and should be flagged as stale (below auto_fix_staleness_below=40).
    const staleFindings = report.findings.filter((f) => f.kind === "stale");
    // At least the non-orphaned pages should be flagged (orphan pages aren't flagged as stale).
    expect(staleFindings.length).toBeGreaterThanOrEqual(3);
  });

  it("report includes summary counts", async () => {
    const root = tmp();
    writePage(root, "concepts", "only", { title: "Only Page", body: "Content." });
    const config = defaultConfig();
    config.wiki_root = root;
    const store = new WikiStore({ wikiRoot: root });
    const search = new WikiSearch();
    search.rebuild(await loadAllPages(store));

    const report = await computeHealthReport(store, null, search, { config });
    expect(report.summary).toBeDefined();
    expect(typeof report.summary.total).toBe("number");
    expect(typeof report.summary.high).toBe("number");
    expect(typeof report.summary.medium).toBe("number");
    expect(typeof report.summary.low).toBe("number");
    expect(typeof report.summary.autoFixable).toBe("number");
  });
});
