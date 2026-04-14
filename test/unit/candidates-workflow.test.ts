/**
 * Unit tests for the candidates workflow: approve, reject, candidates listing.
 */
import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { newPage, parsePage, serializePage } from "../../src/wiki/page.js";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import { approveOne } from "../../src/cli/commands/approve.js";
import type { WotwConfig } from "../../src/utils/types.js";

// Mock git-committer so approveOne does not try to commit.
vi.mock("../../src/ingestion/git-committer.js", () => ({
  commitWikiChanges: vi.fn().mockResolvedValue({
    committed: true,
    sha: "abc123",
    message: "test",
    fileCount: 1,
  }),
}));

function makeConfig(root: string): WotwConfig {
  const config = defaultConfig();
  config.wiki_root = root;
  // Disable provenance so approveOne does not try to init a chain file.
  config.provenance.enabled = false;
  return resolveConfigPaths(config, root);
}

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-candidates-"));
}

function setupStore(wikiRoot: string): WikiStore {
  const store = new WikiStore({ wikiRoot });
  mkdirSync(join(wikiRoot, "wiki", "concepts"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "entities"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "sources"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "comparisons"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "syntheses"), { recursive: true });
  mkdirSync(join(wikiRoot, "wiki", "queries"), { recursive: true });
  mkdirSync(join(wikiRoot, "candidates", "rejected"), { recursive: true });
  return store;
}

function writeCandidate(
  store: WikiStore,
  filename: string,
  title: string,
  category: string,
): string {
  const page = newPage(
    join(store.candidatesDir, filename),
    title,
    category as "concept",
    `This is the body of ${title}.`,
  );
  const path = join(store.candidatesDir, filename);
  writeFileSync(path, serializePage(page));
  return path;
}

describe("WikiStore candidates", () => {
  it("listCandidates returns only .md files in candidates/", () => {
    const root = tmpDir();
    const store = setupStore(root);
    writeCandidate(store, "alpha.md", "Alpha", "concept");
    writeCandidate(store, "beta.md", "Beta", "entity");
    writeFileSync(join(store.candidatesDir, "notes.txt"), "ignore me");

    const candidates = store.listCandidates();
    expect(candidates.length).toBe(2);
    expect(candidates.map((c) => basename(c)).sort()).toEqual(["alpha.md", "beta.md"]);
  });

  it("listCandidates excludes rejected/ subdirectory", () => {
    const root = tmpDir();
    const store = setupStore(root);
    writeCandidate(store, "alpha.md", "Alpha", "concept");
    writeFileSync(join(store.rejectedDir, "old.md"), "rejected content");

    const candidates = store.listCandidates();
    expect(candidates.length).toBe(1);
    expect(basename(candidates[0]!)).toBe("alpha.md");
  });

  it("listRejected returns only .md files in candidates/rejected/", () => {
    const root = tmpDir();
    const store = setupStore(root);
    writeFileSync(join(store.rejectedDir, "bad.md"), "rejected content");
    writeFileSync(join(store.rejectedDir, "notes.txt"), "ignore me");

    const rejected = store.listRejected();
    expect(rejected.length).toBe(1);
    expect(basename(rejected[0]!)).toBe("bad.md");
  });
});

describe("approve workflow", () => {
  it("moves a candidate page to the correct wiki category directory via approveOne", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const config = makeConfig(root);

    const page = newPage(
      join(store.candidatesDir, "machine-learning.md"),
      "Machine Learning",
      "concept",
      "ML is a subset of AI.",
      { sources: ["intro-to-ml.pdf"] },
    );
    writeFileSync(page.path, serializePage(page));

    const ok = await approveOne(page.path, store, config);
    expect(ok).toBe(true);

    const destPath = store.pathFor("concept", "Machine Learning");
    expect(existsSync(destPath)).toBe(true);
    const written = readFileSync(destPath, "utf8");
    expect(written).toContain("Machine Learning");
    expect(written).toContain("concept");
  });

  it("approved page has correct frontmatter after move via approveOne", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const config = makeConfig(root);

    const page = newPage(
      join(store.candidatesDir, "testing.md"),
      "Testing Basics",
      "concept",
      "Unit testing is important.",
      { sources: ["testing-guide.md"], tags: ["testing", "quality"] },
    );
    writeFileSync(page.path, serializePage(page));

    const ok = await approveOne(page.path, store, config);
    expect(ok).toBe(true);

    const destPath = store.pathFor("concept", "Testing Basics");
    const finalRaw = readFileSync(destPath, "utf8");
    const final = parsePage(destPath, finalRaw);
    expect(final.frontmatter.title).toBe("Testing Basics");
    expect(final.frontmatter.category).toBe("concept");
    expect(final.frontmatter.tags).toEqual(["testing", "quality"]);
    expect(final.frontmatter.sources).toEqual(["testing-guide.md"]);
  });

  it("rejects candidate that is older than existing wiki page (superseded)", async () => {
    const root = tmpDir();
    const store = setupStore(root);
    const config = makeConfig(root);

    // Write a candidate with an older timestamp.
    const candidate = newPage(
      join(store.candidatesDir, "superseded-topic.md"),
      "Superseded Topic",
      "concept",
      "Outdated content from candidate.",
      { updated: "2026-04-01T00:00:00Z" },
    );
    writeFileSync(candidate.path, serializePage(candidate));

    // Write a wiki page at the same slug with a newer timestamp.
    const wikiPath = store.pathFor("concept", "Superseded Topic");
    const existing = newPage(
      wikiPath,
      "Superseded Topic",
      "concept",
      "Newer authoritative content.",
      { updated: "2026-04-10T00:00:00Z" },
    );
    writeFileSync(wikiPath, serializePage(existing));

    // approveOne should return false because the candidate is older.
    const ok = await approveOne(candidate.path, store, config);
    expect(ok).toBe(false);

    // Wiki page should still have the newer content.
    const wikiRaw = readFileSync(wikiPath, "utf8");
    const wikiPage = parsePage(wikiPath, wikiRaw);
    expect(wikiPage.body).toBe("Newer authoritative content.");
    expect(wikiPage.frontmatter.updated).toBe("2026-04-10T00:00:00Z");
  });
});

describe("reject workflow", () => {
  it("rejected page gets rejection metadata in frontmatter", () => {
    const root = tmpDir();
    const store = setupStore(root);

    const page = newPage(
      join(store.candidatesDir, "bad-page.md"),
      "Bad Page",
      "concept",
      "This page is not good enough.",
    );
    writeFileSync(page.path, serializePage(page));

    // Simulate reject logic: parse, add rejection fields, write to rejected/.
    const raw = readFileSync(page.path, "utf8");
    const parsed = parsePage(page.path, raw);
    parsed.frontmatter.rejected_at = "2026-04-09T12:00:00.000Z";
    parsed.frontmatter.rejection_note = "Needs more detail on algorithms.";
    const rejectedPath = join(store.rejectedDir, "bad-page.md");
    parsed.path = rejectedPath;
    writeFileSync(rejectedPath, serializePage(parsed));

    const rejectedRaw = readFileSync(rejectedPath, "utf8");
    const rejected = parsePage(rejectedPath, rejectedRaw);
    expect(rejected.frontmatter.rejected_at).toBe("2026-04-09T12:00:00.000Z");
    expect(rejected.frontmatter.rejection_note).toBe("Needs more detail on algorithms.");
  });

  it("rejected page preserves original body content", () => {
    const root = tmpDir();
    const store = setupStore(root);

    const body = "Original content that should be preserved verbatim.";
    const page = newPage(
      join(store.candidatesDir, "preserve-me.md"),
      "Preserve Me",
      "entity",
      body,
    );
    writeFileSync(page.path, serializePage(page));

    const raw = readFileSync(page.path, "utf8");
    const parsed = parsePage(page.path, raw);
    parsed.frontmatter.rejected_at = new Date().toISOString();
    const rejectedPath = join(store.rejectedDir, "preserve-me.md");
    parsed.path = rejectedPath;
    writeFileSync(rejectedPath, serializePage(parsed));

    const rejectedRaw = readFileSync(rejectedPath, "utf8");
    const rejected = parsePage(rejectedPath, rejectedRaw);
    expect(rejected.body).toBe(body);
  });

  it("rejection without reason still sets rejected_at", () => {
    const root = tmpDir();
    const store = setupStore(root);

    const page = newPage(
      join(store.candidatesDir, "no-reason.md"),
      "No Reason",
      "concept",
      "Body text.",
    );
    writeFileSync(page.path, serializePage(page));

    const raw = readFileSync(page.path, "utf8");
    const parsed = parsePage(page.path, raw);
    parsed.frontmatter.rejected_at = "2026-04-09T00:00:00.000Z";
    // No rejection_note set.
    const rejectedPath = join(store.rejectedDir, "no-reason.md");
    writeFileSync(rejectedPath, serializePage(parsed));

    const rejectedRaw = readFileSync(rejectedPath, "utf8");
    const rejected = parsePage(rejectedPath, rejectedRaw);
    expect(rejected.frontmatter.rejected_at).toBe("2026-04-09T00:00:00.000Z");
    expect(rejected.frontmatter.rejection_note).toBeUndefined();
  });
});

describe("candidates listing", () => {
  it("empty candidates returns empty arrays", () => {
    const root = tmpDir();
    const store = setupStore(root);
    expect(store.listCandidates()).toEqual([]);
    expect(store.listRejected()).toEqual([]);
  });

  it("candidates and rejected are counted separately", () => {
    const root = tmpDir();
    const store = setupStore(root);

    writeCandidate(store, "a.md", "A", "concept");
    writeCandidate(store, "b.md", "B", "concept");
    writeFileSync(
      join(store.rejectedDir, "c.md"),
      serializePage(newPage(join(store.rejectedDir, "c.md"), "C", "concept", "rejected body")),
    );

    expect(store.listCandidates().length).toBe(2);
    expect(store.listRejected().length).toBe(1);
  });
});
