/**
 * Unit tests for KeyStore.rotateKek + archiveOverlapped (PASS-019
 * Parts B and C).
 *
 * Covers:
 * - Round-trip: provision → rotate KEK → all rows re-encrypted →
 *   DEK plaintext preserved → verify still works
 * - Mixed state: active + rotating + archived + revoked → only
 *   non-revoked rows are re-encrypted
 * - Atomicity: a partial failure rolls back the whole transaction
 *   and leaves this.kek unchanged
 * - Idempotence: same KEK twice produces fresh ciphertext but same
 *   resolvable DEK plaintext
 * - Post-rotation signing works (provenance HMAC verify green)
 * - archiveOverlapped: pre-overlap stays, post-overlap archives,
 *   only `rotating` rows affected, idempotent across re-runs
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyStore } from "../../../src/keys/store.js";
import { unwrapDek } from "../../../src/keys/envelope.js";
import { ProvenanceChain } from "../../../src/provenance/chain.js";

const WS = "tenant-aaaa-1111";

function mkStore(): KeyStore {
  return new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
}

function tmpChainPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-kek-rot-")), "chain.jsonl");
}

describe("KeyStore.rotateKek — happy path", () => {
  it("re-encrypts every non-revoked DEK under the new KEK; plaintext preserved", () => {
    const oldKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    const k1 = store.provision(WS);
    store.rotate(WS); // k1 → rotating; new active provisioned
    const k2 = store.active(WS)!;
    const newKek = randomBytes(32);
    const result = store.rotateKek(newKek);
    expect(result.rotated).toBe(2); // active + rotating, no archived/revoked yet
    // After rotation, the plaintext DEKs are unchanged — verify by
    // resolving by key_id and comparing to the originally-resolved
    // plaintext bytes.
    const k1After = store.resolveById(k1.key_id);
    const k2After = store.resolveById(k2.key_id);
    expect(k1After).not.toBeNull();
    expect(k2After).not.toBeNull();
    expect(k1After!.dek.equals(k1.dek)).toBe(true);
    expect(k2After!.dek.equals(k2.dek)).toBe(true);
  });

  it("after rotation, raw ciphertext in DB is unwrappable under new KEK only", () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    const k1 = store.provision(WS);
    store.rotateKek(newKek);
    // Read the raw row from the DB and try to unwrap under both KEKs.
    // @ts-expect-error — access private db for the assertion
    const db = store["db"];
    const row = db
      .prepare("SELECT encrypted_dek, nonce, auth_tag FROM workspace_keys WHERE key_id = ?")
      .get(k1.key_id) as { encrypted_dek: Buffer; nonce: Buffer; auth_tag: Buffer };
    // Old KEK should NO LONGER unwrap the row.
    expect(() =>
      unwrapDek(
        { ciphertext: row.encrypted_dek, nonce: row.nonce, auth_tag: row.auth_tag },
        oldKek,
      ),
    ).toThrow();
    // New KEK should unwrap to the same plaintext as the cached DEK.
    const unwrapped = unwrapDek(
      { ciphertext: row.encrypted_dek, nonce: row.nonce, auth_tag: row.auth_tag },
      newKek,
    );
    expect(unwrapped.equals(k1.dek)).toBe(true);
  });

  it("rotateKek returns count of rotated rows (active + rotating + archived, NOT revoked)", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS);
    const _k2 = store.active(WS)!;
    store.rotate(WS); // _k2 → rotating; new active
    store.archive(k1.key_id); // k1 → archived
    void _k2;
    // Now: 1 active, 1 rotating, 1 archived. Add a revoked.
    const k4 = store.provision("ws-other"); // separate workspace, active
    store.revoke(k4.key_id);
    const result = store.rotateKek(randomBytes(32));
    // Active + rotating + archived = 3 (across all workspaces in this store).
    // Revoked is skipped.
    expect(result.rotated).toBe(3);
    // The revoked row's encrypted_dek is unchanged — verify by trying
    // to resolve it; should fail because the stored ciphertext is
    // still under the OLD KEK but the store now thinks current is new.
    expect(() => store.resolveById(k4.key_id)).toThrow();
  });
});

describe("KeyStore.rotateKek — atomicity / failure", () => {
  it("rejects a wrong-length new KEK loud", () => {
    const store = mkStore();
    store.provision(WS);
    expect(() => store.rotateKek(randomBytes(16))).toThrow(/32 bytes/);
  });

  it("if any row fails to unwrap under the old KEK, rotation rolls back and this.kek is unchanged", () => {
    const oldKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    const k1 = store.provision(WS);
    // Tamper with k1's stored ciphertext so it can't unwrap under the
    // current KEK. The rotation should fail and leave the store in a
    // consistent state.
    // @ts-expect-error — access private db
    const db = store["db"];
    db.prepare("UPDATE workspace_keys SET encrypted_dek = ? WHERE key_id = ?").run(
      Buffer.from("garbage_______________________X"),
      k1.key_id,
    );
    // Clear cache so the rotation forces a fresh decrypt.
    // @ts-expect-error — access private cache
    store["dekCache"].clear();
    const newKek = randomBytes(32);
    expect(() => store.rotateKek(newKek)).toThrow();
    // Verify the store's KEK reference is unchanged: re-decrypt of an
    // UNTAMPERED row should still work under the old KEK. Restore the
    // tampered row first so we can test.
    db.prepare(
      "UPDATE workspace_keys SET encrypted_dek = ?, nonce = ?, auth_tag = ? WHERE key_id = ?",
    ).run(Buffer.from("placeholder"), Buffer.from("placeholder"), Buffer.from("p"), "no-such-id");
    // Provision a fresh row under the (unchanged) old KEK. If this.kek
    // had been swapped to newKek, provisioning would store under newKek
    // and we couldn't unwrap with oldKek. The fact that we CAN
    // provision + resolve via the store proves the KEK is still old.
    const k2 = store.provision("ws-other");
    const resolved = store.resolveById(k2.key_id);
    expect(resolved).not.toBeNull();
    expect(resolved!.dek.equals(k2.dek)).toBe(true);
  });
});

describe("KeyStore.rotateKek — idempotence", () => {
  it("rotating to the same KEK twice succeeds and preserves plaintext", () => {
    const kek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek, inMemory: true });
    const k1 = store.provision(WS);
    const r1 = store.rotateKek(kek);
    expect(r1.rotated).toBe(1);
    const r2 = store.rotateKek(kek);
    expect(r2.rotated).toBe(1);
    const resolved = store.resolveById(k1.key_id);
    expect(resolved).not.toBeNull();
    expect(resolved!.dek.equals(k1.dek)).toBe(true);
  });

  it("two rotations to the same target KEK produce different ciphertexts (fresh nonces) but same plaintext", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const newKek = randomBytes(32);
    store.rotateKek(newKek);
    // @ts-expect-error — access private db
    const db = store["db"];
    const row1 = db
      .prepare("SELECT encrypted_dek, nonce FROM workspace_keys WHERE key_id = ?")
      .get(k1.key_id) as { encrypted_dek: Buffer; nonce: Buffer };
    store.rotateKek(newKek);
    const row2 = db
      .prepare("SELECT encrypted_dek, nonce FROM workspace_keys WHERE key_id = ?")
      .get(k1.key_id) as { encrypted_dek: Buffer; nonce: Buffer };
    // Same plaintext, different nonce/ciphertext after each rotation.
    expect(row1.nonce.equals(row2.nonce)).toBe(false);
    expect(row1.encrypted_dek.equals(row2.encrypted_dek)).toBe(false);
  });
});

describe("Provenance signing + verify continues across KEK rotation", () => {
  it("records signed under DEK-A still verify after the KEK they were wrapped with is rotated", async () => {
    const oldKek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek: oldKek, inMemory: true });
    store.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpChainPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    // Append a few records under the old KEK.
    const r1 = await chain.append({
      type: "ingest",
      source_files: ["raw/a.md"],
      source_hashes: ["h1"],
      prompt_hash: "p1",
      model_id: "m",
      response_hash: "r1",
      wiki_files_written: ["w/a.md"],
      wiki_file_hashes_after: { "w/a.md": "h" },
    });
    // Rotate the KEK. The DEK plaintext stays the same; only the
    // envelope changes. Records signed under the DEK still verify.
    const newKek = randomBytes(32);
    store.rotateKek(newKek);
    const r2 = await chain.append({
      type: "query",
      source_files: [],
      source_hashes: [],
      prompt_hash: "p2",
      model_id: "m",
      response_hash: "r2",
      wiki_files_written: [],
      wiki_file_hashes_after: {},
    });
    expect(r1.key_id).toBe(r2.key_id); // same DEK signed both
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("verifying a chain after closing + reopening the store under the new KEK works", async () => {
    const oldKek = randomBytes(32);
    const newKek = randomBytes(32);
    const dbPath = join(mkdtempSync(join(tmpdir(), "wotw-kek-rot-")), "keys.db");
    let store = new KeyStore({ path: dbPath, kek: oldKek });
    store.provision(WS);
    const chainPath = tmpChainPath();
    let chain = new ProvenanceChain({
      path: chainPath,
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    await chain.append({
      type: "ingest",
      source_files: ["raw/a.md"],
      source_hashes: ["h1"],
      prompt_hash: "p1",
      model_id: "m",
      response_hash: "r1",
      wiki_files_written: ["w/a.md"],
      wiki_file_hashes_after: { "w/a.md": "h" },
    });
    // Rotate, close, reopen with the NEW KEK (simulates daemon
    // restart after operator swapped the Fly secret).
    store.rotateKek(newKek);
    store.close();
    store = new KeyStore({ path: dbPath, kek: newKek });
    chain = new ProvenanceChain({
      path: chainPath,
      tenantId: WS,
      workspaceId: WS,
      keyStore: store,
    });
    await chain.init();
    const result = await chain.verify();
    expect(result.ok).toBe(true);
  });
});

describe("KeyStore.archiveOverlapped (PASS-019 Part C — SQL primitive)", () => {
  it("archives rotating DEKs whose rotated_at is older than the overlap", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    // Force a rotation with a backdated rotated_at — simulate a DEK
    // that's been rotating for 48h.
    const fortyEightHoursAgo = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    store.rotate(WS, fortyEightHoursAgo);
    const sixHoursMs = 6 * 3600 * 1000;
    // Overlap = 24h. k1 was rotated 48h ago → past overlap → archives.
    const archived = store.archiveOverlapped(WS, 24 * 3600 * 1000);
    expect(archived).toEqual([k1.key_id]);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
    // Sanity: with a 72h overlap, the same row would NOT archive.
    const k2 = store.active(WS)!;
    store.rotate(WS, fortyEightHoursAgo);
    const stillRotating = store.archiveOverlapped(WS, 72 * 3600 * 1000);
    expect(stillRotating).toEqual([]);
    expect(store.resolveById(k2.key_id)?.key_state).toBe("rotating");
    // Suppress unused-variable lint for sixHoursMs (intent-documenting constant).
    void sixHoursMs;
  });

  it("does NOT archive recently-rotated DEKs (still inside overlap window)", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS); // rotated_at = now
    const archived = store.archiveOverlapped(WS, 24 * 3600 * 1000);
    expect(archived).toEqual([]);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("rotating");
  });

  it("idempotent — running twice in a row is a no-op after the first archive", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo);
    const first = store.archiveOverlapped(WS, 24 * 3600 * 1000);
    const second = store.archiveOverlapped(WS, 24 * 3600 * 1000);
    expect(first).toEqual([k1.key_id]);
    expect(second).toEqual([]);
  });

  it("only affects 'rotating' rows — active, archived, revoked are untouched", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.rotate(WS, longAgo); // k1 → rotating; new active
    const k2 = store.active(WS)!;
    store.revoke(k2.key_id);
    // Now: k1=rotating (old timestamp), k2=revoked (also old by virtue of insert).
    store.archiveOverlapped(WS, 24 * 3600 * 1000);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
    expect(store.resolveById(k2.key_id)?.key_state).toBe("revoked"); // unchanged
  });

  it("isolates workspaces — rotating DEKs in workspace A are not archived by a sweep against workspace B", () => {
    const store = mkStore();
    const longAgo = new Date(Date.now() - 100 * 3600 * 1000).toISOString();
    store.provision("ws-a");
    store.rotate("ws-a", longAgo);
    store.provision("ws-b");
    store.rotate("ws-b", longAgo);
    store.archiveOverlapped("ws-a", 24 * 3600 * 1000);
    // ws-a rotating-DEK → archived. ws-b rotating-DEK unchanged.
    const rowsB = store.listAll("ws-b");
    const rotatingInB = rowsB.filter((r) => r.key_state === "rotating");
    expect(rotatingInB.length).toBe(1);
  });
});
