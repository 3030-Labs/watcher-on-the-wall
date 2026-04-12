/**
 * Unit tests for ProvenanceChain: append, recovery on restart, verification,
 * tamper detection, and concurrent append ordering.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvenanceChain, type ProvenanceAppendInput } from "../../src/provenance/chain.js";
import { GENESIS_HASH } from "../../src/provenance/hash.js";
import type { ProvenanceRecord } from "../../src/utils/types.js";

function makeInput(overrides: Partial<ProvenanceAppendInput> = {}): ProvenanceAppendInput {
  return {
    type: "ingest",
    source_files: ["raw/note.md"],
    source_hashes: ["abc"],
    prompt_hash: "deadbeef",
    model_id: "claude-haiku-4-5",
    response_hash: "cafebabe",
    wiki_files_written: ["wiki/concepts/foo.md"],
    wiki_file_hashes_after: { "wiki/concepts/foo.md": "feed" },
    metadata: { cost_usd: 0.01 },
    ...overrides,
  };
}

function tmpChainPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "wotw-chain-"));
  return join(dir, "provenance-chain.jsonl");
}

describe("ProvenanceChain.init", () => {
  it("initializes an empty chain when the file does not exist", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    expect(chain.count()).toBe(0);
    expect(chain.head()).toBe(GENESIS_HASH);
  });

  it("is idempotent", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    await chain.init();
    expect(chain.count()).toBe(0);
  });
});

describe("ProvenanceChain.append", () => {
  it("appends the first record with GENESIS_HASH as previous_chain_hash", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    const rec = await chain.append(makeInput());
    expect(rec.seq).toBe(1);
    expect(rec.previous_id).toBeNull();
    expect(rec.previous_chain_hash).toBe(GENESIS_HASH);
    expect(rec.chain_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rec.id).toMatch(/^[0-9a-f]{64}$/);
    expect(chain.count()).toBe(1);
    expect(chain.head()).toBe(rec.chain_hash);
  });

  it("chains each subsequent record's previous_chain_hash to the prior chain_hash", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    const r1 = await chain.append(makeInput());
    const r2 = await chain.append(makeInput({ type: "query" }));
    const r3 = await chain.append(makeInput({ type: "compound" }));
    expect(r2.seq).toBe(2);
    expect(r2.previous_id).toBe(r1.id);
    expect(r2.previous_chain_hash).toBe(r1.chain_hash);
    expect(r3.seq).toBe(3);
    expect(r3.previous_id).toBe(r2.id);
    expect(r3.previous_chain_hash).toBe(r2.chain_hash);
  });

  it("persists records as JSONL that can be parsed back", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));
    const text = readFileSync(path, "utf8");
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as ProvenanceRecord);
    expect(parsed[0]!.seq).toBe(1);
    expect(parsed[1]!.seq).toBe(2);
  });

  it("serializes concurrent appends in FIFO order via the write lock", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    const promises = Array.from({ length: 10 }, (_, i) =>
      chain.append(makeInput({ metadata: { idx: i } })),
    );
    const results = await Promise.all(promises);
    const seqs = results.map((r) => r.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (let i = 1; i < results.length; i++) {
      expect(results[i]!.previous_chain_hash).toBe(results[i - 1]!.chain_hash);
    }
  });
});

describe("ProvenanceChain recovery", () => {
  it("recovers nextSeq and lastChainHash on restart", async () => {
    const path = tmpChainPath();
    const first = new ProvenanceChain({ path });
    await first.init();
    const r1 = await first.append(makeInput());
    const r2 = await first.append(makeInput({ type: "query" }));

    const second = new ProvenanceChain({ path });
    await second.init();
    expect(second.count()).toBe(2);
    expect(second.head()).toBe(r2.chain_hash);
    const r3 = await second.append(makeInput({ type: "compound" }));
    expect(r3.seq).toBe(3);
    expect(r3.previous_id).toBe(r2.id);
    expect(r3.previous_chain_hash).toBe(r2.chain_hash);
    expect(r3.chain_hash).not.toBe(r1.chain_hash);
  });
});

describe("ProvenanceChain.verify", () => {
  it("passes a clean chain", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));
    await chain.append(makeInput({ type: "compound" }));
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalRecords).toBe(3);
    expect(result.verifiedRecords).toBe(3);
  });

  it("detects id tampering (content changed, hash stale)", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    const r1 = JSON.parse(lines[0]!) as ProvenanceRecord;
    r1.metadata = { ...(r1.metadata ?? {}), cost_usd: 9999 };
    lines[0] = JSON.stringify(r1);
    writeFileSync(path, lines.join("\n") + "\n");

    const result = await chain.verify();
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(result.errors[0]!.reason).toContain("id hash mismatch");
    expect(result.errors[0]!.seq).toBe(1);
  });

  it("detects a deleted middle record (seq gap)", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));
    await chain.append(makeInput({ type: "compound" }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    writeFileSync(path, lines[0]! + "\n" + lines[2]! + "\n");

    const result = await chain.verify();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason.includes("seq mismatch"))).toBe(true);
  });

  it("detects a tampered chain_hash", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));

    const lines = readFileSync(path, "utf8").trim().split("\n");
    const r2 = JSON.parse(lines[1]!) as ProvenanceRecord;
    r2.chain_hash = "a".repeat(64);
    lines[1] = JSON.stringify(r2);
    writeFileSync(path, lines.join("\n") + "\n");

    const result = await chain.verify();
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.reason.includes("chain_hash mismatch"))).toBe(true);
  });
});

describe("ProvenanceChain queries", () => {
  it("recordsFor returns entries matching a wiki file", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    await chain.append(
      makeInput({
        wiki_files_written: ["wiki/concepts/foo.md"],
        wiki_file_hashes_after: { "wiki/concepts/foo.md": "h" },
      }),
    );
    await chain.append(
      makeInput({
        wiki_files_written: ["wiki/concepts/bar.md"],
        wiki_file_hashes_after: { "wiki/concepts/bar.md": "h" },
      }),
    );
    await chain.append(
      makeInput({
        type: "query",
        source_files: ["wiki/concepts/foo.md"],
        source_hashes: ["h"],
        wiki_files_written: [],
        wiki_file_hashes_after: {},
      }),
    );
    const foo = await chain.recordsFor("wiki/concepts/foo.md");
    expect(foo).toHaveLength(2);
    expect(foo.map((r) => r.seq)).toEqual([1, 3]);
    const bar = await chain.recordsFor("wiki/concepts/bar.md");
    expect(bar).toHaveLength(1);
    expect(bar[0]!.seq).toBe(2);
  });

  it("readRecent returns the most recent N records", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    for (let i = 0; i < 5; i++) {
      await chain.append(makeInput({ metadata: { idx: i } }));
    }
    const recent = await chain.readRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent.map((r) => r.seq)).toEqual([3, 4, 5]);
  });

  it("signature is stable across reads and changes when chain changes", async () => {
    const chain = new ProvenanceChain({ path: tmpChainPath() });
    await chain.init();
    await chain.append(makeInput());
    const s1a = await chain.signature();
    const s1b = await chain.signature();
    expect(s1a).toBe(s1b);
    await chain.append(makeInput({ type: "query" }));
    const s2 = await chain.signature();
    expect(s2).not.toBe(s1a);
  });
});

describe("CRITICAL-5: chain corruption detection on init", () => {
  // REVERT CHECK: If the corruption guard in init() (lines ~99-113 in
  // chain.ts) is reverted, a file full of garbage will silently parse as
  // 0 valid records and the chain will reset to GENESIS_HASH -- the next
  // append will start at seq=1, destroying the integrity of the entire
  // provenance history. This test verifies init() throws instead.

  it("throws when the file has content but no valid records (full corruption)", async () => {
    const path = tmpChainPath();
    // Build a real chain with 5 records.
    const chain = new ProvenanceChain({ path });
    await chain.init();
    for (let i = 0; i < 5; i++) {
      await chain.append(makeInput({ metadata: { idx: i } }));
    }
    expect(chain.count()).toBe(5);

    // Overwrite the entire file with garbage.
    writeFileSync(path, "this is not json\ncorrupted line 2\ngarbage\n");

    // A new chain instance must detect corruption and throw.
    const corrupted = new ProvenanceChain({ path });
    await expect(corrupted.init()).rejects.toThrow(/corrupted|no valid records/);
  });

  it("partial corruption: init succeeds but reads fewer records", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();
    for (let i = 0; i < 5; i++) {
      await chain.append(makeInput({ metadata: { idx: i } }));
    }

    // Corrupt just the middle line (line 3 = index 2) by replacing it
    // with garbage. Lines 1, 2, 4, 5 remain valid JSON.
    const lines = readFileSync(path, "utf8").trim().split("\n");
    expect(lines.length).toBe(5);
    lines[2] = "THIS_IS_GARBAGE_NOT_JSON";
    writeFileSync(path, lines.join("\n") + "\n");

    // A new chain should still init (there are valid records), but it
    // will read fewer than 5 records because the corrupted line is skipped.
    const recovered = new ProvenanceChain({ path });
    await recovered.init();
    const allRecords = await recovered.readAll();
    expect(allRecords.length).toBe(4); // 5 minus 1 corrupted
    expect(allRecords.length).toBeLessThan(5);
  });
});

describe("CRITICAL-6: fsync error propagation in append", () => {
  // REVERT CHECK: If the `await handle.sync()` at line ~192 in chain.ts
  // is wrapped in a .catch() or removed, fsync failures will be silently
  // swallowed. The in-memory state would advance (nextSeq, lastChainHash)
  // even though the record was never durably persisted, causing silent
  // data loss. This test forces sync() to throw and verifies append rejects.

  it("append rejects when handle.sync() fails", async () => {
    const path = tmpChainPath();
    const chain = new ProvenanceChain({ path });
    await chain.init();

    // Get the FileHandle prototype by opening a temporary file, then spy
    // on its sync method to make it throw on the next call.
    const tmpHandle = await open(path, "a");
    const fileHandleProto = Object.getPrototypeOf(tmpHandle) as { sync: () => Promise<void> };
    await tmpHandle.close();

    const syncSpy = vi
      .spyOn(fileHandleProto, "sync")
      .mockRejectedValueOnce(new Error("simulated fsync failure"));

    try {
      await expect(chain.append(makeInput())).rejects.toThrow("simulated fsync failure");
    } finally {
      syncSpy.mockRestore();
    }
  });
});
