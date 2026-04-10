/**
 * Unit tests for the candidates staging integration:
 * - reconcileWrittenPages with staging=true redirects pages to candidates/
 * - Prompt builder includes rejection feedback from rejected/ directory
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { newPage, serializePage } from "../../src/wiki/page.js";
import { reconcileWrittenPages } from "../../src/ingestion/wiki-writer.js";
import { buildIngestionPrompt } from "../../src/ingestion/prompt-builder.js";
import { defaultConfig } from "../../src/daemon/config.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-staging-"));
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

describe("reconcileWrittenPages with staging", () => {
  it("staging=true redirects pages to candidates/", async () => {
    const root = tmpDir();
    const store = setupStore(root);

    // Simulate what the agent writes: a page in wiki/concepts/.
    const agentWrittenPath = join(root, "wiki", "concepts", "test-topic.md");
    const page = newPage(agentWrittenPath, "Test Topic", "concept", "Agent-written content.");
    writeFileSync(agentWrittenPath, serializePage(page));

    const result = await reconcileWrittenPages(store, [agentWrittenPath], { staging: true });

    expect(result.pages.length).toBe(1);
    // Page should be in candidates/, not concepts/.
    expect(basename(result.pages[0]!.path)).toBe("test-topic.md");
    expect(result.pages[0]!.path).toContain("candidates");
    expect(existsSync(join(store.candidatesDir, "test-topic.md"))).toBe(true);
    // Original file should be cleaned up.
    expect(existsSync(agentWrittenPath)).toBe(false);
  });

  it("staging=false keeps pages in category dir (backward compatible)", async () => {
    const root = tmpDir();
    const store = setupStore(root);

    const agentWrittenPath = join(root, "wiki", "concepts", "direct-topic.md");
    const page = newPage(agentWrittenPath, "Direct Topic", "concept", "Goes directly to wiki.");
    writeFileSync(agentWrittenPath, serializePage(page));

    const result = await reconcileWrittenPages(store, [agentWrittenPath], { staging: false });

    expect(result.pages.length).toBe(1);
    expect(existsSync(agentWrittenPath)).toBe(true);
    expect(result.pages[0]!.path).toBe(agentWrittenPath);
  });

  it("staging=undefined (default) keeps pages in category dir", async () => {
    const root = tmpDir();
    const store = setupStore(root);

    const agentWrittenPath = join(root, "wiki", "concepts", "default-topic.md");
    const page = newPage(agentWrittenPath, "Default Topic", "concept", "Default behavior.");
    writeFileSync(agentWrittenPath, serializePage(page));

    const result = await reconcileWrittenPages(store, [agentWrittenPath]);

    expect(result.pages.length).toBe(1);
    expect(existsSync(agentWrittenPath)).toBe(true);
  });
});

describe("prompt builder rejection feedback", () => {
  it("includes rejection reasons from rejected/ directory", async () => {
    const root = tmpDir();
    setupStore(root);
    mkdirSync(join(root, "raw"), { recursive: true });

    // Write a source file.
    const sourceFile = join(root, "raw", "notes.md");
    writeFileSync(sourceFile, "Some source content.");

    // Write a rejected page with a rejection_note.
    const rejected = newPage(
      join(root, "candidates", "rejected", "bad-article.md"),
      "Bad Article",
      "concept",
      "Content with errors.",
    );
    rejected.frontmatter.rejected_at = "2026-04-09T12:00:00.000Z";
    rejected.frontmatter.rejection_note = "Dates are inaccurate";
    writeFileSync(join(root, "candidates", "rejected", "bad-article.md"), serializePage(rejected));

    const config = { ...defaultConfig(), wiki_root: root, raw_path: join(root, "raw") };
    const prompt = await buildIngestionPrompt({
      config,
      files: [sourceFile],
    });

    expect(prompt.text).toContain("Previous rejections");
    expect(prompt.text).toContain("Bad Article");
    expect(prompt.text).toContain("Dates are inaccurate");
  });

  it("no rejection feedback when rejected/ is empty", async () => {
    const root = tmpDir();
    setupStore(root);
    mkdirSync(join(root, "raw"), { recursive: true });

    const sourceFile = join(root, "raw", "notes.md");
    writeFileSync(sourceFile, "Some source content.");

    const config = { ...defaultConfig(), wiki_root: root, raw_path: join(root, "raw") };
    const prompt = await buildIngestionPrompt({
      config,
      files: [sourceFile],
    });

    expect(prompt.text).not.toContain("Previous rejections");
  });
});
