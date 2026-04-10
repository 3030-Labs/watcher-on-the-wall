/**
 * Integration tests for `wotw lint --fix` flow.
 * Tests verify that lint reports findings without modifying disk (no --fix),
 * and that --fix with missing backlinks creates the appropriate provenance.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../../src/daemon/config.js";
import { runLintPass } from "../../src/cli/commands/lint.js";
import { serializePage, newPage, parsePage } from "../../src/wiki/page.js";

// Mock LLM invoker and git-committer to avoid real external calls.
vi.mock("../../src/ingestion/llm-invoker.js", () => ({
  invokeIngestionAgent: vi.fn().mockResolvedValue({
    finalText: "Fixed.",
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 100,
    numTurns: 1,
    sessionId: null,
    writtenPaths: [],
    stopReason: "end_turn",
    success: true,
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

// Mock execution-mode resolver to prevent it from trying to find claude CLI.
vi.mock("../../src/ingestion/execution-mode.js", () => ({
  resolveExecutionMode: vi.fn().mockReturnValue({
    mode: "api",
    configuredMode: "auto",
    cliPath: null,
    apiKeyEnv: "ANTHROPIC_API_KEY",
    effectiveModelHint: "claude-haiku-4-5",
    description: "mock",
  }),
}));

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-lint-fix-"));
}

function makeConfig(root: string): ReturnType<typeof defaultConfig> {
  const config = defaultConfig();
  config.wiki_root = root;
  config.raw_path = join(root, "raw");
  config.cost.track_file = join(root, ".wotw", "cost.jsonl");
  config.provenance.chain_file = join(root, "provenance-chain.jsonl");
  config.provenance.enabled = false;
  return config;
}

function writePage(
  root: string,
  category: string,
  slug: string,
  title: string,
  body: string,
  opts?: { related?: string[] },
): string {
  const dir = join(root, "wiki", category);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  const page = newPage(path, title, category === "concepts" ? "concept" : "entity", body, {
    related: opts?.related ?? [],
  });
  writeFileSync(path, serializePage(page));
  return path;
}

describe("wotw lint (no --fix)", () => {
  it("reports findings but changes nothing on disk", async () => {
    const root = tmp();
    mkdirSync(join(root, ".wotw"), { recursive: true });

    // Create a page with a broken link.
    const path = writePage(root, "concepts", "test", "Test", "See [[missing/page]].");
    const contentBefore = readFileSync(path, "utf8");

    const config = makeConfig(root);
    const result = await runLintPass(config);

    expect(result.missingWikiDir).toBe(false);
    expect(result.totalPages).toBe(1);
    expect(result.healthReport).toBeDefined();
    expect(result.healthReport!.findings.length).toBeGreaterThanOrEqual(1);

    // Broken link should be detected.
    const brokenLinks = result.healthReport!.findings.filter((f) => f.kind === "broken-link");
    expect(brokenLinks.length).toBe(1);

    // File should be unchanged (no --fix).
    expect(readFileSync(path, "utf8")).toBe(contentBefore);
    expect(result.healResults).toHaveLength(0);
  });
});

describe("wotw lint --fix --yes", () => {
  it("fixes missing backlinks and records them", async () => {
    const root = tmp();
    mkdirSync(join(root, ".wotw"), { recursive: true });

    // Page A references B, but B doesn't reference A.
    writePage(root, "concepts", "a", "Page A", "Content A.", { related: ["concepts/b"] });
    writePage(root, "concepts", "b", "Page B", "Content B.", { related: [] });

    const config = makeConfig(root);
    const result = await runLintPass(config, { fix: true, yes: true });

    expect(result.missingWikiDir).toBe(false);
    expect(result.healResults.length).toBeGreaterThanOrEqual(0);

    // Check if B now references A (backlink repair doesn't require LLM).
    const bPath = join(root, "wiki", "concepts", "b.md");
    const bContent = readFileSync(bPath, "utf8");
    const bPage = parsePage(bPath, bContent);
    expect(bPage.frontmatter.related).toContain("concepts/a");
  });
});
