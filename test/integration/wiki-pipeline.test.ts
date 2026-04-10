/**
 * Integration test: the full wiki store + index manager + search + provenance
 * pipeline, end-to-end, without touching the LLM. Simulates what the daemon
 * does after an ingestion batch: reconcile written pages, repair bidirectional
 * links, rebuild the index, refresh search, and append a provenance record.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WikiStore } from "../../src/wiki/store.js";
import { IndexManager } from "../../src/wiki/index-manager.js";
import { WikiSearch } from "../../src/wiki/search.js";
import { newPage } from "../../src/wiki/page.js";
import { loadAllPages, reconcileWrittenPages } from "../../src/ingestion/wiki-writer.js";
import { repairBidirectionalLinks } from "../../src/wiki/cross-reference.js";
import { ProvenanceChain } from "../../src/provenance/chain.js";
import { GENESIS_HASH, sha256Canonical, sha256Hex } from "../../src/provenance/hash.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-integration-"));
}

describe("wiki pipeline (no LLM)", () => {
  it("stores, parses, indexes, and searches pages end-to-end", async () => {
    const root = tmpRoot();
    const store = new WikiStore({ wikiRoot: root });
    const indexManager = new IndexManager(store);
    const search = new WikiSearch();
    const chain = new ProvenanceChain({ path: join(root, "provenance-chain.jsonl") });
    await store.ensureLayout();
    await chain.init();

    // --- Simulate an agent writing two wiki pages directly to disk ---
    const hashChains = newPage(
      store.pathFor("concept", "Hash Chains"),
      "Hash Chains",
      "concept",
      "A hash chain is a sequence where each record commits to the previous via SHA-256.",
      { tags: ["crypto", "integrity"], sources: ["raw/notes.md"] },
    );
    const merkle = newPage(
      store.pathFor("concept", "Merkle Trees"),
      "Merkle Trees",
      "concept",
      "Merkle trees generalize hash chains into a tree structure for log-N verification.",
      { tags: ["crypto", "data-structures"], related: ["concepts/hash-chains"] },
    );
    await store.writePage(hashChains);
    await store.writePage(merkle);

    // Reconcile the raw paths (as ingestion would after an agent run).
    const reconciled = await reconcileWrittenPages(store, [hashChains.path, merkle.path]);
    expect(reconciled.pages).toHaveLength(2);
    expect(reconciled.skipped).toHaveLength(0);

    // Rebuild cross-references: merkle lists hash-chains as related but
    // hash-chains does NOT list merkle yet. Bidirectional repair should add it.
    const allPages = await loadAllPages(store);
    expect(allPages).toHaveLength(2);
    const mutated = repairBidirectionalLinks(store, allPages);
    expect(mutated).toHaveLength(1);
    expect(mutated[0]!.frontmatter.title).toBe("Hash Chains");
    for (const p of mutated) await store.writePage(p);

    // Reload and verify.
    const finalPages = await loadAllPages(store);
    const hc = finalPages.find((p) => p.frontmatter.title === "Hash Chains")!;
    expect(hc.frontmatter.related).toContain("concepts/merkle-trees");

    // Rebuild the index manager.
    await indexManager.rebuild(finalPages);
    const indexText = readFileSync(join(store.wikiDir, "index.md"), "utf8");
    expect(indexText).toContain("Hash Chains");
    expect(indexText).toContain("Merkle Trees");
    expect(indexText).toContain("<!-- wotw:index:start -->");

    // Rebuild search and query.
    search.rebuild(finalPages);
    expect(search.size()).toBe(2);
    const results = search.search("merkle");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.title).toBe("Merkle Trees");

    // Append a provenance record covering both writes.
    const rec = await chain.append({
      type: "ingest",
      source_files: ["raw/notes.md"],
      source_hashes: [sha256Hex("raw note content")],
      prompt_hash: sha256Hex("system prompt"),
      model_id: "claude-haiku-4-5",
      response_hash: sha256Hex("agent response"),
      wiki_files_written: [hashChains.path, merkle.path].map((p) => p.replace(root + "/", "")),
      wiki_file_hashes_after: {},
      metadata: { cost_usd: 0.012 },
    });
    expect(rec.seq).toBe(1);
    expect(rec.previous_chain_hash).toBe(GENESIS_HASH);

    // Verify the chain passes a clean walk.
    const verification = await chain.verify();
    expect(verification.ok).toBe(true);
    expect(verification.verifiedRecords).toBe(1);
  });

  it("reconcileWrittenPages rejects paths outside the wiki dir", async () => {
    const root = tmpRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    // Write a file OUTSIDE the wiki dir.
    const outside = join(root, "not-wiki.md");
    writeFileSync(outside, "---\ntitle: Bad\n---\nbody");

    const result = await reconcileWrittenPages(store, [outside]);
    expect(result.pages).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toContain("outside");
  });

  it("reconcileWrittenPages reports missing files as skipped", async () => {
    const root = tmpRoot();
    const store = new WikiStore({ wikiRoot: root });
    await store.ensureLayout();
    const ghost = join(store.wikiDir, "concepts", "ghost.md");
    const result = await reconcileWrittenPages(store, [ghost]);
    expect(result.pages).toHaveLength(0);
    expect(result.skipped[0]!.reason).toContain("not found");
  });
});

describe("provenance canonical hash matches manual computation", () => {
  it("generates deterministic record IDs independent of insertion order", async () => {
    const chain = new ProvenanceChain({
      path: join(tmpRoot(), "provenance-chain.jsonl"),
    });
    await chain.init();
    const rec = await chain.append({
      type: "ingest",
      source_files: ["a.md", "b.md"],
      source_hashes: ["h1", "h2"],
      prompt_hash: "p",
      model_id: "claude-haiku-4-5",
      response_hash: "r",
      wiki_files_written: ["wiki/concepts/x.md"],
      wiki_file_hashes_after: { "wiki/concepts/x.md": "wh1" },
      metadata: { foo: "bar" },
    });
    // Manually compute the expected id.
    const payload = {
      seq: 1,
      timestamp: rec.timestamp,
      type: "ingest",
      source_files: ["a.md", "b.md"],
      source_hashes: ["h1", "h2"],
      prompt_hash: "p",
      model_id: "claude-haiku-4-5",
      response_hash: "r",
      wiki_files_written: ["wiki/concepts/x.md"],
      wiki_file_hashes_after: { "wiki/concepts/x.md": "wh1" },
      previous_id: null,
      previous_chain_hash: GENESIS_HASH,
      metadata: { foo: "bar" },
    };
    const expectedId = sha256Canonical(payload);
    expect(rec.id).toBe(expectedId);
    // chain_hash = H(prev_chain_hash || id)
    const expectedChainHash = sha256Hex(GENESIS_HASH + expectedId);
    expect(rec.chain_hash).toBe(expectedChainHash);
  });
});
