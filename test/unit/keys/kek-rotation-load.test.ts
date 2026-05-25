/**
 * KEK rotation under simulated in-flight signing load (PASS-019 Part B).
 *
 * The goal directive's hard gate: "rotation under in-flight signing
 * load, mid-rotation failure rolls back cleanly, post-rotation tail-
 * verify green across all DEK ages." This file covers the orchestration
 * around rotation — the unit-level guarantees are in kek-rotation.test.ts
 * and store.test.ts.
 *
 * Strategy:
 * - Sign N records before rotation
 * - Trigger KEK rotation
 * - Sign N more records after rotation
 * - Mid-chain DEK rotate (Part B's neighbor primitive, KeyStore.rotate)
 * - Verify the entire chain end-to-end at the end
 *
 * Plus a dedicated test that interleaves a KEK rotation with a DEK
 * rotation to exercise the boundary case where the operator rotates
 * both around the same time.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore } from "../../../src/keys/store.js";
import { ProvenanceChain, type ProvenanceAppendInput } from "../../../src/provenance/chain.js";

const WS = "tenant-aaaa-1111";

function mkInput(seq: number): ProvenanceAppendInput {
  return {
    type: "ingest",
    source_files: [`raw/note-${seq}.md`],
    source_hashes: [`h${seq}`],
    prompt_hash: `prompt-${seq}`,
    model_id: "claude-haiku-4-5",
    response_hash: `resp-${seq}`,
    wiki_files_written: [`wiki/foo-${seq}.md`],
    wiki_file_hashes_after: { [`wiki/foo-${seq}.md`]: `f${seq}` },
  };
}

function tmpChainPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-kek-load-")), "chain.jsonl");
}

describe("KEK rotation orchestration — pre-rotation signing + rotate + post-rotation signing", () => {
  it("a 50-record chain (25 pre-rotation, 25 post-rotation) tail-verifies green", async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    store.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpChainPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    for (let i = 0; i < 25; i++) {
      await chain.append(mkInput(i));
    }
    // Rotate KEK mid-chain. DEK plaintext is unchanged, so all 25
    // existing records still verify; subsequent records sign under the
    // same DEK (because we didn't rotate the DEK, only the KEK).
    store.rotateKek(newKek);
    for (let i = 25; i < 50; i++) {
      await chain.append(mkInput(i));
    }
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.totalRecords).toBe(50);
    expect(result.errors).toEqual([]);
  });

  it("DEK rotation followed by KEK rotation: chain still verifies across both", async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    store.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpChainPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    // Phase 1: append under DEK-1 + old KEK
    for (let i = 0; i < 10; i++) await chain.append(mkInput(i));
    // Rotate DEK: new active DEK-2, old DEK-1 → rotating. Records 0-9
    // still verifiable via DEK-1.
    store.rotate(WS);
    // Phase 2: append under DEK-2 + old KEK
    for (let i = 10; i < 20; i++) await chain.append(mkInput(i));
    // Rotate KEK: re-encrypts BOTH DEK-1 and DEK-2 under newKek.
    // DEK plaintexts unchanged — records 0-19 still verify.
    store.rotateKek(newKek);
    // Phase 3: append under DEK-2 + new KEK
    for (let i = 20; i < 30; i++) await chain.append(mkInput(i));
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.totalRecords).toBe(30);
  });
});

describe("KEK rotation followed by daemon restart simulation", () => {
  it("a fresh KeyStore opened with the new KEK can verify the chain it didn't sign", async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const dbPath = join(mkdtempSync(join(tmpdir(), "wotw-kek-restart-")), "keys.db");
    const chainPath = tmpChainPath();

    let store = new KeyStore({ path: dbPath, kek: oldKek });
    store.provision(WS);
    let chain = new ProvenanceChain({
      path: chainPath,
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    for (let i = 0; i < 5; i++) await chain.append(mkInput(i));
    store.rotateKek(newKek);
    // Simulate operator swap: old daemon stops; new daemon starts with
    // only the new KEK in env. Old KEK should not be needed anymore.
    store.close();
    store = new KeyStore({ path: dbPath, kek: newKek });
    chain = new ProvenanceChain({
      path: chainPath,
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    // Verify all 5 pre-restart records.
    const verify1 = await chain.verify();
    expect(verify1.ok).toBe(true);
    // Append 5 more under the new KEK; verify still green.
    for (let i = 5; i < 10; i++) await chain.append(mkInput(i));
    const verify2 = await chain.verify();
    expect(verify2.ok).toBe(true);
    expect(verify2.totalRecords).toBe(10);
  });

  it("opening a KeyStore with the WRONG (old) KEK after rotation fails decryption attempts", () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const dbPath = join(mkdtempSync(join(tmpdir(), "wotw-kek-wrong-")), "keys.db");

    let store = new KeyStore({ path: dbPath, kek: oldKek });
    const k1 = store.provision(WS);
    store.rotateKek(newKek);
    store.close();

    // Reopen with the OLD KEK. The store accepts the construct (KEK
    // validation is by length only, not by ability to decrypt
    // existing rows). But any resolveById() throws on the GCM auth
    // tag mismatch — fail loud.
    store = new KeyStore({ path: dbPath, kek: oldKek });
    expect(() => store.resolveById(k1.key_id)).toThrow();
  });
});

describe("Edge cases", () => {
  it("rotateKek on an empty workspace (no DEKs yet) succeeds with rotated=0", () => {
    const store = new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
    const result = store.rotateKek(randomBytes(32));
    expect(result.rotated).toBe(0);
  });

  it("archiveOverlapped on an empty workspace returns []", () => {
    const store = new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
    expect(store.archiveOverlapped("nonexistent-ws", 24 * 3600 * 1000)).toEqual([]);
  });

  it("archiveOverlapped with overlapMs=0 archives immediately (everything past 0s is past)", () => {
    const store = new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
    const k1 = store.provision(WS);
    const aSecondAgo = new Date(Date.now() - 1000).toISOString();
    store.rotate(WS, aSecondAgo);
    const archived = store.archiveOverlapped(WS, 0);
    expect(archived).toEqual([k1.key_id]);
  });

  it("rotateKek with cache pre-populated still works (clears cache, re-decrypts under new KEK)", () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    const k1 = store.provision(WS);
    // Warm the cache.
    expect(store.resolveById(k1.key_id)).not.toBeNull();
    store.rotateKek(newKek);
    // Resolve after rotation — cache was cleared, will re-decrypt
    // under newKek. Plaintext must match the original.
    const after = store.resolveById(k1.key_id);
    expect(after).not.toBeNull();
    expect(after!.dek.equals(k1.dek)).toBe(true);
  });
});
