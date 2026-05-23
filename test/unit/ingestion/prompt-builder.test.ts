/**
 * Tests for buildIngestionPrompt — review item 17 closure.
 *
 * The pre-fix prompt contained ZERO existing-wiki context, so the model
 * could not dedupe, merge, supersede, or match conventions. The fix wires
 * a slim existing-pages manifest through to the prompt with X1-C1
 * scope-bound: full list when ≤200 pages, top-50 by token-overlap above.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIngestionPrompt,
  EXISTING_PAGES_FULL_LIST_LIMIT,
  EXISTING_PAGES_PROMPT_CAP,
  type ExistingPageManifestEntry,
} from "../../../src/ingestion/prompt-builder.js";
import { defaultConfig } from "../../../src/daemon/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-prompt-"));
}

function makeConfig(wikiRoot: string): ReturnType<typeof defaultConfig> {
  const cfg = defaultConfig();
  cfg.wiki_root = wikiRoot;
  cfg.raw_path = join(wikiRoot, "raw");
  mkdirSync(cfg.raw_path, { recursive: true });
  return cfg;
}

function makeSourceFile(root: string, name: string, body: string): string {
  const path = join(root, "raw", name);
  writeFileSync(path, body);
  return path;
}

describe("buildIngestionPrompt — review item 17: existing-wiki context", () => {
  it("renders no manifest section when no existing pages are passed", async () => {
    const root = tmp();
    const cfg = makeConfig(root);
    const file = makeSourceFile(root, "src.md", "photosynthesis content");

    const prompt = await buildIngestionPrompt({
      config: cfg,
      files: [file],
      claudeMdOverride: "system",
    });

    expect(prompt.text).not.toContain("## Existing wiki pages");
  });

  it("renders manifest section with all pages when wiki is small", async () => {
    const root = tmp();
    const cfg = makeConfig(root);
    const file = makeSourceFile(root, "src.md", "photosynthesis content");

    const existingPages: ExistingPageManifestEntry[] = [
      {
        path: "wiki/concepts/photosynthesis.md",
        title: "Photosynthesis",
        category: "concept",
        tags: ["biology", "energy"],
      },
      {
        path: "wiki/entities/chloroplast.md",
        title: "Chloroplast",
        category: "entity",
      },
    ];

    const prompt = await buildIngestionPrompt({
      config: cfg,
      files: [file],
      claudeMdOverride: "system",
      existingPages,
    });

    expect(prompt.text).toContain("## Existing wiki pages");
    expect(prompt.text).toContain("wiki/concepts/photosynthesis.md");
    expect(prompt.text).toContain("Photosynthesis");
    expect(prompt.text).toContain("wiki/entities/chloroplast.md");
    expect(prompt.text).toContain("Prefer updating an existing page");
  });

  it("caps manifest at EXISTING_PAGES_PROMPT_CAP for large wikis", async () => {
    const root = tmp();
    const cfg = makeConfig(root);
    const file = makeSourceFile(root, "src.md", "photosynthesis biology energy plant chloroplast");

    // Build > FULL_LIST_LIMIT pages to trigger ranking + cap.
    const pages: ExistingPageManifestEntry[] = [];
    for (let i = 0; i < EXISTING_PAGES_FULL_LIST_LIMIT + 10; i++) {
      pages.push({
        path: `wiki/concepts/page-${i}.md`,
        title: i < 5 ? "Photosynthesis topic" : `Unrelated topic ${i}`,
        category: "concept",
        tags: i < 5 ? ["biology", "energy"] : ["unrelated"],
      });
    }

    const prompt = await buildIngestionPrompt({
      config: cfg,
      files: [file],
      claudeMdOverride: "system",
      existingPages: pages,
    });

    // Count pages rendered in manifest (each is a "- `path`" line).
    const lines = prompt.text.split("\n").filter((l) => l.startsWith("- `wiki/"));
    expect(lines.length).toBe(EXISTING_PAGES_PROMPT_CAP);

    // The top-ranked entries should be the photosynthesis-tagged ones
    // (they overlap with source tokens "photosynthesis", "biology", etc).
    const renderedText = prompt.text;
    // At least one of the relevant pages is included.
    expect(renderedText).toContain("page-0.md");
  });

  it("manifest absent for empty existingPages array (defensive)", async () => {
    const root = tmp();
    const cfg = makeConfig(root);
    const file = makeSourceFile(root, "src.md", "content");

    const prompt = await buildIngestionPrompt({
      config: cfg,
      files: [file],
      claudeMdOverride: "system",
      existingPages: [],
    });

    expect(prompt.text).not.toContain("## Existing wiki pages");
  });
});
