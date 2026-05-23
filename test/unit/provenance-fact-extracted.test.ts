/**
 * Forward/backward compatibility tests for the Pass B ProvenanceRecord
 * schema extension (fact_hashes_added + fact_hashes_superseded fields,
 * and the `fact_extracted` OperationType).
 *
 * Goal contract:
 *   - Old daemon reads new chain: must ignore unknown fields when parsing.
 *   - New daemon reads old chain: must verify cleanly without these fields.
 *   - fact_hashes_* are NOT folded into the canonical payload, so the
 *     id + chain_hash + hmac stay identical to a record without them.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvenanceChain } from "../../src/provenance/chain.js";

function tmpChainPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-prov-fact-")), "chain.jsonl");
}

describe("ProvenanceRecord: backward compat", () => {
  it("new daemon reads an old chain (no fact_hashes_* fields) and verifies", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append({
      type: "ingest",
      source_files: ["raw/x.txt"],
      source_hashes: ["sha1"],
      prompt_hash: "p",
      model_id: "m",
      response_hash: "r",
      wiki_files_written: ["wiki/concepts/x.md"],
      wiki_file_hashes_after: { "wiki/concepts/x.md": "h" },
    });
    const v = await chain.verify();
    expect(v.ok).toBe(true);
    expect(v.totalRecords).toBe(1);
  });
});

describe("ProvenanceRecord: forward compat — fact_hashes_* are stored but NOT canonical", () => {
  it("a fact_extracted record verifies identically with or without the extension fields", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    // Append a record with the new fields.
    await chain.append({
      type: "fact_extracted",
      source_files: ["wiki/concepts/x.md"],
      source_hashes: ["sha"],
      prompt_hash: "p",
      model_id: "m",
      response_hash: "r",
      wiki_files_written: [],
      wiki_file_hashes_after: {},
      fact_hashes_added: ["fact-1", "fact-2"],
      fact_hashes_superseded: [],
    });
    const v = await chain.verify();
    expect(v.ok).toBe(true);
    expect(v.totalRecords).toBe(1);

    // The record on disk should include the new fields.
    const raw = readFileSync(path, "utf8").trim().split("\n");
    expect(raw).toHaveLength(1);
    const record = JSON.parse(raw[0]!);
    expect(record.type).toBe("fact_extracted");
    expect(record.fact_hashes_added).toEqual(["fact-1", "fact-2"]);
    // canonical id is computed from a payload that does NOT include
    // fact_hashes_*. Compute the canonical payload manually and confirm
    // the id matches:
    const { sha256Canonical } = await import("../../src/provenance/hash.js");
    const canonicalPayload: Record<string, unknown> = {
      seq: record.seq,
      timestamp: record.timestamp,
      type: record.type,
      source_files: record.source_files,
      source_hashes: record.source_hashes,
      prompt_hash: record.prompt_hash,
      model_id: record.model_id,
      response_hash: record.response_hash,
      wiki_files_written: record.wiki_files_written,
      wiki_file_hashes_after: record.wiki_file_hashes_after,
      previous_id: record.previous_id,
      previous_chain_hash: record.previous_chain_hash,
    };
    const recomputedId = sha256Canonical(canonicalPayload);
    expect(recomputedId).toBe(record.id);
  });

  it("appends a record with no fact_hashes_* fields when omitted (no empty arrays leak)", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append({
      type: "fact_extracted",
      source_files: ["wiki/concepts/x.md"],
      source_hashes: ["sha"],
      prompt_hash: "p",
      model_id: "m",
      response_hash: "r",
      wiki_files_written: [],
      wiki_file_hashes_after: {},
      fact_hashes_added: [],
      fact_hashes_superseded: [],
    });
    const raw = readFileSync(path, "utf8").trim();
    const record = JSON.parse(raw);
    expect(record.fact_hashes_added).toBeUndefined();
    expect(record.fact_hashes_superseded).toBeUndefined();
  });
});

describe("OperationType extension: fact_extracted accepted", () => {
  it("appends a fact_extracted record and reads it back", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append({
      type: "fact_extracted",
      source_files: ["wiki/concepts/x.md"],
      source_hashes: ["sha"],
      prompt_hash: "p",
      model_id: "m",
      response_hash: "r",
      wiki_files_written: [],
      wiki_file_hashes_after: {},
    });
    const records = await chain.readRecent(1);
    expect(records[0]!.type).toBe("fact_extracted");
  });
});
