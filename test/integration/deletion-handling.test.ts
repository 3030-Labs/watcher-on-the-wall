/**
 * Integration test for Feature 2: deletion handling (archive, don't delete).
 *
 * Drives the IngestionQueue through a deletion-only batch and asserts:
 *   1. Affected wiki pages are marked `status: orphaned` in frontmatter
 *   2. Wiki files are NOT deleted from disk
 *   3. An "archive" provenance record is appended
 *   4. `wotw lint`-style orphan count surfaces the change
 *
 * We bypass the LLM by pre-seeding the wiki with hand-written pages and
 * pre-seeding the provenance chain with an `ingest` record that claims
 * the pages were produced from a specific raw source. Then we enqueue a
 * batch with `deletedPaths: [that source]` and verify the archive path
 * fires end-to-end.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage } from "../../src/wiki/page.js";
import { ProvenanceChain } from "../../src/provenance/chain.js";
import { sha256Hex } from "../../src/provenance/hash.js";
import { IngestionQueue } from "../../src/ingestion/queue.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { defaultConfig } from "../../src/daemon/config.js";
import { runLintPass } from "../../src/cli/commands/lint.js";
import type { WatcherBatch } from "../../src/watcher/index.js";
import type { WotwConfig } from "../../src/utils/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-delete-"));
}

function buildConfig(root: string): WotwConfig {
  const cfg = defaultConfig();
  cfg.wiki_root = root;
  cfg.raw_path = join(root, "raw");
  cfg.cost.track_file = join(root, "cost-log.jsonl");
  cfg.provenance.chain_file = join(root, "provenance-chain.jsonl");
  cfg.ingestion.dead_letter_file = "";
  return cfg;
}

describe("deletion handling (archive)", () => {
  it("marks affected wiki pages as orphaned and appends an archive record", async () => {
    const root = tmpRoot();
    const config = buildConfig(root);
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const indexManager = new IndexManager(store);
    const search = new WikiSearch();
    const chain = new ProvenanceChain({ path: config.provenance.chain_file });
    await chain.init();

    // Seed two wiki pages that came from a single raw source.
    const hashChains = newPage(
      store.pathFor("concept", "Hash Chains"),
      "Hash Chains",
      "concept",
      "A hash chain is a sequence where each record commits to the previous via SHA-256.",
      { tags: ["crypto"], sources: ["raw/notes.md"] },
    );
    const merkle = newPage(
      store.pathFor("concept", "Merkle Trees"),
      "Merkle Trees",
      "concept",
      "Merkle trees generalize hash chains into a tree structure.",
      { tags: ["crypto"], sources: ["raw/notes.md"] },
    );
    await store.writePage(hashChains);
    await store.writePage(merkle);

    // Seed the provenance chain with a record that produced both pages
    // from the (now-deleted) raw source.
    const hashChainsRel = relative(root, hashChains.path);
    const merkleRel = relative(root, merkle.path);
    await chain.append({
      type: "ingest",
      source_files: ["raw/notes.md"],
      source_hashes: [sha256Hex("raw note content")],
      prompt_hash: sha256Hex("system prompt"),
      model_id: "claude-haiku-4-5",
      response_hash: sha256Hex("agent response"),
      wiki_files_written: [hashChainsRel, merkleRel],
      wiki_file_hashes_after: {},
      metadata: { batch_id: "seed-batch" },
    });
    expect(chain.count()).toBe(1);

    // Now enqueue a deletion-only batch naming the raw source. The queue
    // must short-circuit straight to archiveDeletedSources — no LLM call.
    const rawAbs = join(root, "raw", "notes.md");
    // The queue uses path.relative(wikiRoot, abs) so the path doesn't
    // need to physically exist on disk — only the provenance mapping
    // needs to reference the same wiki-relative form.
    const queue = new IngestionQueue({
      config,
      store,
      indexManager,
      search,
      costTracker: new CostTracker({
        trackFile: config.cost.track_file,
        maxDailyUsd: config.cost.max_daily_usd,
        maxPerIngestUsd: config.cost.max_per_ingest_usd,
        maxPerQueryUsd: config.cost.max_per_query_usd,
      }),
      modelRouter: new ModelRouter(config),
      provenance: chain,
      runtimeMode: "api",
    });

    const batch: WatcherBatch = {
      id: "delete-batch-1",
      createdAt: new Date().toISOString(),
      paths: [],
      reasons: {},
      deletedPaths: [rawAbs],
    };
    const outcome = await queue.enqueue(batch);
    expect(outcome.skipped).toBe(false);
    expect(outcome.costUsd).toBe(0);
    // pagesWritten on an archive batch counts the archived (rewritten)
    // pages, which is our primary deliverable.
    expect(outcome.pagesWritten).toBe(2);

    // Wiki files must still exist on disk.
    expect(existsSync(hashChains.path)).toBe(true);
    expect(existsSync(merkle.path)).toBe(true);

    // Both pages must be marked orphaned.
    const reloadedHC = await store.readPage(hashChains.path);
    const reloadedMK = await store.readPage(merkle.path);
    expect(reloadedHC?.frontmatter.status).toBe("orphaned");
    expect(reloadedMK?.frontmatter.status).toBe("orphaned");
    expect(reloadedHC?.frontmatter.orphaned_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reloadedHC?.frontmatter.orphaned_source).toContain("raw/notes.md");
    expect(reloadedMK?.frontmatter.orphaned_source).toContain("raw/notes.md");

    // Provenance chain should now have one additional record of type "archive".
    const all = await chain.readAll();
    expect(all).toHaveLength(2);
    const archive = all[1]!;
    expect(archive.type).toBe("archive");
    expect(archive.source_files).toContain("raw/notes.md");
    expect(archive.source_hashes).toEqual(["deleted"]);
    expect(archive.wiki_files_written.length).toBe(2);
    expect(archive.metadata?.orphaned_pages).toBe(2);

    // lint should now report 2 orphaned pages.
    const lint = await runLintPass(config);
    expect(lint.orphanedPages).toBe(2);
    expect(lint.issueCount).toBe(2);

    // Chain still verifies clean after the archive append.
    const verification = await chain.verify();
    expect(verification.ok).toBe(true);
  });

  it("records an archive event even when no wiki pages are affected", async () => {
    const root = tmpRoot();
    const config = buildConfig(root);
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const indexManager = new IndexManager(store);
    const search = new WikiSearch();
    const chain = new ProvenanceChain({ path: config.provenance.chain_file });
    await chain.init();

    // No provenance history → deleting a raw file leaves nothing to orphan.
    const queue = new IngestionQueue({
      config,
      store,
      indexManager,
      search,
      costTracker: new CostTracker({
        trackFile: config.cost.track_file,
        maxDailyUsd: config.cost.max_daily_usd,
        maxPerIngestUsd: config.cost.max_per_ingest_usd,
        maxPerQueryUsd: config.cost.max_per_query_usd,
      }),
      modelRouter: new ModelRouter(config),
      provenance: chain,
      runtimeMode: "api",
    });

    const batch: WatcherBatch = {
      id: "orphan-delete-1",
      createdAt: new Date().toISOString(),
      paths: [],
      reasons: {},
      deletedPaths: [join(root, "raw", "never-ingested.md")],
    };
    const outcome = await queue.enqueue(batch);
    expect(outcome.skipped).toBe(false);
    expect(outcome.pagesWritten).toBe(0);

    // Even with no pages affected the archive record is still appended
    // so the chain reflects that a deletion was observed.
    const all = await chain.readAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.type).toBe("archive");
  });
});
