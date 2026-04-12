/**
 * Regression tests for HIGH-7: Vocabulary enricher real hashes.
 *
 * Verifies that `runVocabularyEnrichment`:
 *   1. Enriches page key_terms via LLM and writes updated page
 *   2. Records provenance with real content hashes (not static
 *      `sha256Hex("vocabulary-enrichment")`)
 *   3. Skips when zero-hit rate is below threshold
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, resolveConfigPaths } from "../../src/daemon/config.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { WikiStore } from "../../src/wiki/store.js";
import { newPage, parsePage, serializePage } from "../../src/wiki/page.js";
import { ProvenanceChain } from "../../src/provenance/chain.js";
import { sha256Hex } from "../../src/provenance/hash.js";

// Mock the LLM invoker to avoid actual API calls.
vi.mock("../../src/ingestion/llm-invoker.js", () => ({
  invokeIngestionAgent: vi.fn().mockResolvedValue({
    finalText: '{ "matches": [] }',
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
  return mkdtempSync(join(tmpdir(), "wotw-vocab-"));
}

function makeOpts(root: string) {
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, ".wotw", "cost.jsonl");
  cfg.provenance.chain_file = join(root, ".wotw", "provenance-chain.jsonl");
  cfg.health.query_log_file = join(root, ".wotw", "query-log.jsonl");
  cfg.health.enrichment_enabled = true;
  cfg.health.zero_hit_threshold = 0.2;
  cfg.health.max_fixes_per_run = 10;
  mkdirSync(join(root, ".wotw"), { recursive: true });
  const config = resolveConfigPaths(cfg);

  const store = new WikiStore({ wikiRoot: config.wiki_root });
  const search = new WikiSearch();
  const costTracker = new CostTracker({
    trackFile: config.cost.track_file,
    maxDailyUsd: 10,
    maxPerIngestUsd: 2,
    maxPerQueryUsd: 0.5,
  });
  const modelRouter = new ModelRouter(config);

  return { config, store, search, costTracker, modelRouter };
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
  const cat = category === "concepts" ? "concept" : "entity";
  const page = newPage(path, title, cat, body);
  writeFileSync(path, serializePage(page));
  return path;
}

/**
 * Write query-log JSONL entries. All entries are timestamped "now" so they
 * fall within the default 7-day window of computeZeroHitRate.
 */
function writeQueryLog(
  logFile: string,
  entries: Array<{ query: string; zero_hit: boolean }>,
): void {
  mkdirSync(join(logFile, ".."), { recursive: true });
  for (const e of entries) {
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      query: e.query,
      zero_hit: e.zero_hit,
      citations: e.zero_hit ? 0 : 3,
    });
    appendFileSync(logFile, line + "\n");
  }
}

describe("HIGH-7: vocabulary enricher real hashes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enriches page key_terms via LLM and writes updated page", async () => {
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    await store.ensureLayout();

    // Write a page that the LLM will suggest enriching.
    const pagePath = writePage(
      root,
      "concepts",
      "test-page",
      "Test Page",
      "Some content about testing.",
    );
    const relPath = "wiki/concepts/test-page.md";

    // Rebuild search index.
    const { loadAllPages } = await import("../../src/ingestion/wiki-writer.js");
    const allPages = await loadAllPages(store);
    search.rebuild(allPages);

    // Create a query log with high zero-hit rate.
    writeQueryLog(config.health.query_log_file, [
      { query: "testing methodology", zero_hit: true },
      { query: "test patterns", zero_hit: true },
      { query: "found query", zero_hit: false },
    ]);

    // Mock the LLM to suggest adding terms to our page.
    vi.mocked(invokeIngestionAgent).mockResolvedValue({
      finalText: JSON.stringify({
        matches: [
          {
            page: relPath,
            add_terms: ["testing methodology", "test patterns"],
          },
        ],
      }),
      totalCostUsd: 0.002,
      inputTokens: 200,
      outputTokens: 100,
      durationMs: 600,
      numTurns: 1,
      sessionId: null,
      writtenPaths: [],
      stopReason: "end_turn",
      success: true,
    });

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: null,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    // Verify LLM was called.
    expect(invokeIngestionAgent).toHaveBeenCalled();

    // Verify enrichment occurred.
    expect(result.skipped).toBe(false);
    expect(result.pagesEnriched).toBeGreaterThanOrEqual(1);
    expect(result.termsAdded).toBeGreaterThanOrEqual(1);

    // Verify the page was updated with new key_terms.
    const raw = readFileSync(pagePath, "utf8");
    const updatedPage = parsePage(pagePath, raw);
    expect(updatedPage.frontmatter.key_terms).toBeDefined();
    expect(updatedPage.frontmatter.key_terms).toContain("testing methodology");
    expect(updatedPage.frontmatter.key_terms).toContain("test patterns");
  });

  it("records provenance with real content hashes (not static)", async () => {
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    await store.ensureLayout();

    writePage(root, "concepts", "hashable", "Hashable Page", "Content for hashing.");
    const relPath = "wiki/concepts/hashable.md";

    const { loadAllPages } = await import("../../src/ingestion/wiki-writer.js");
    const allPages = await loadAllPages(store);
    search.rebuild(allPages);

    // Create a query log with high zero-hit rate.
    writeQueryLog(config.health.query_log_file, [
      { query: "unique term alpha", zero_hit: true },
      { query: "another zero hit", zero_hit: true },
      { query: "found", zero_hit: false },
    ]);

    const llmResponseText = JSON.stringify({
      matches: [
        {
          page: relPath,
          add_terms: ["unique term alpha"],
        },
      ],
    });

    vi.mocked(invokeIngestionAgent).mockResolvedValue({
      finalText: llmResponseText,
      totalCostUsd: 0.003,
      inputTokens: 300,
      outputTokens: 150,
      durationMs: 700,
      numTurns: 1,
      sessionId: null,
      writtenPaths: [],
      stopReason: "end_turn",
      success: true,
    });

    // Create a real ProvenanceChain to capture the appended record.
    const chain = new ProvenanceChain({ path: config.provenance.chain_file });
    await chain.init();

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: chain,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(false);
    expect(result.pagesEnriched).toBeGreaterThanOrEqual(1);

    // Read the provenance chain and check the last record.
    const records = await chain.readAll();
    expect(records.length).toBeGreaterThanOrEqual(1);

    const lastRecord = records[records.length - 1]!;
    expect(lastRecord.type).toBe("heal");

    // HIGH-7: The prompt_hash and response_hash must be real content hashes,
    // NOT the static sha256Hex("vocabulary-enrichment") that was used before.
    const staticHash = sha256Hex("vocabulary-enrichment");
    expect(lastRecord.prompt_hash).not.toBe(staticHash);
    expect(lastRecord.response_hash).not.toBe(staticHash);

    // Verify prompt_hash is the hash of the actual queries joined by newline.
    // The first zero-hit query processed is "unique term alpha". The second
    // would be "another zero hit" but the LLM is called per-query, so
    // allPrompts collects one entry per LLM call. With our mock returning
    // matches only for the first query, but both queries are processed.
    // The prompt_hash should be sha256Hex of the queries joined with "\n".
    // Since the LLM is called for each query in queriesToProcess, and the mock
    // returns the same response each time, allPrompts will contain both queries.
    expect(lastRecord.prompt_hash.length).toBe(64); // SHA-256 hex length
    expect(lastRecord.response_hash.length).toBe(64);

    // Verify the response_hash is derived from actual LLM response text.
    // The mock returns the same response text for each call.
    // With 2 zero-hit queries, allResponses has 2 entries of llmResponseText.
    const expectedResponseHash = sha256Hex([llmResponseText, llmResponseText].join("\n"));
    expect(lastRecord.response_hash).toBe(expectedResponseHash);

    // Verify the prompt_hash is derived from the actual query strings.
    const expectedPromptHash = sha256Hex(["unique term alpha", "another zero hit"].join("\n"));
    expect(lastRecord.prompt_hash).toBe(expectedPromptHash);

    // Verify metadata.
    expect(lastRecord.metadata).toBeDefined();
    expect(lastRecord.metadata!.heal_kind).toBe("vocabulary-enrichment");
  });

  it("skips when enrichment is disabled", async () => {
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    config.health.enrichment_enabled = false;
    await store.ensureLayout();

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: null,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("enrichment disabled");
    expect(result.pagesEnriched).toBe(0);
    expect(result.termsAdded).toBe(0);
  });

  it("skips when zero-hit rate is below threshold", async () => {
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    await store.ensureLayout();

    // Create a query log with LOW zero-hit rate (below 20% threshold).
    writeQueryLog(config.health.query_log_file, [
      { query: "found 1", zero_hit: false },
      { query: "found 2", zero_hit: false },
      { query: "found 3", zero_hit: false },
      { query: "found 4", zero_hit: false },
      { query: "found 5", zero_hit: false },
      { query: "found 6", zero_hit: false },
      { query: "found 7", zero_hit: false },
      { query: "found 8", zero_hit: false },
      { query: "found 9", zero_hit: false },
      { query: "missed", zero_hit: true },
    ]);

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: null,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(true);
    expect(result.skipReason).toContain("below threshold");
    expect(result.pagesEnriched).toBe(0);
  });

  it("skips when there are no queries at all (empty log)", async () => {
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    await store.ensureLayout();

    // No query log file → zero_hit_rate is 0 which is <= threshold.
    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: null,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(true);
    expect(result.pagesEnriched).toBe(0);
  });

  it("does not add duplicate key_terms that already exist on the page", async () => {
    const { invokeIngestionAgent } = await import("../../src/ingestion/llm-invoker.js");
    const root = tmp();
    const { config, store, search, costTracker, modelRouter } = makeOpts(root);
    await store.ensureLayout();

    // Write a page that already has some key_terms.
    const dir = join(root, "wiki", "concepts");
    mkdirSync(dir, { recursive: true });
    const pagePath = join(dir, "existing-terms.md");
    const page = newPage(pagePath, "Existing Terms", "concept", "Content.", {
      key_terms: ["existing_term"],
    });
    writeFileSync(pagePath, serializePage(page));
    const relPath = "wiki/concepts/existing-terms.md";

    const { loadAllPages } = await import("../../src/ingestion/wiki-writer.js");
    search.rebuild(await loadAllPages(store));

    writeQueryLog(config.health.query_log_file, [
      { query: "dedup test", zero_hit: true },
      { query: "another miss", zero_hit: true },
      { query: "hit", zero_hit: false },
    ]);

    vi.mocked(invokeIngestionAgent).mockResolvedValue({
      finalText: JSON.stringify({
        matches: [
          {
            page: relPath,
            add_terms: ["existing_term", "brand_new_term"],
          },
        ],
      }),
      totalCostUsd: 0.001,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 500,
      numTurns: 1,
      sessionId: null,
      writtenPaths: [],
      stopReason: "end_turn",
      success: true,
    });

    const { runVocabularyEnrichment } = await import("../../src/wiki/vocabulary-enricher.js");
    const result = await runVocabularyEnrichment({
      config,
      store,
      search,
      provenance: null,
      costTracker,
      modelRouter,
      runtimeMode: "api",
    });

    expect(result.skipped).toBe(false);

    // Read the updated page.
    const raw = readFileSync(pagePath, "utf8");
    const updatedPage = parsePage(pagePath, raw);
    const terms = updatedPage.frontmatter.key_terms ?? [];

    // "existing_term" should appear exactly once (not duplicated).
    expect(terms.filter((t) => t === "existing_term").length).toBe(1);
    // "brand_new_term" should be added.
    expect(terms).toContain("brand_new_term");
  });
});
