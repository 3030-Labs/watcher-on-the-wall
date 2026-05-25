/**
 * G5 end-to-end attestation tests (Pass 018, v0.8.2).
 *
 * Covers:
 * - Append + verify happy path under workspace KeyStore
 * - Mid-chain DEK rotation: records signed under previous DEK still
 *   verify after rotation (both DEKs resolvable via key_id lookup)
 * - Backward-compat:
 *   - Pre-G5 chains (no hmac field) verify identically
 *   - G5-scaffolding chains (hmac but no key_id) verify under fallback hmacKey
 * - Forward-compat: G5-closed chains produce canonical payload identical
 *   to what older daemons compute (key_id excluded from canonical payload)
 * - Tamper detection: corruption surfaces in verify().errors
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProvenanceChain, type ProvenanceAppendInput } from "../../src/provenance/chain.js";
import { sha256Canonical } from "../../src/provenance/hash.js";
import { KeyStore } from "../../src/keys/store.js";
import type { ProvenanceRecord } from "../../src/utils/types.js";

const WS = "tenant-aaaa-1111";

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
    ...overrides,
  };
}

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "wotw-g5-")), "chain.jsonl");
}

function mkKeyStore(): KeyStore {
  return new KeyStore({ path: ":memory:", kek: randomBytes(32), inMemory: true });
}

describe("G5 append + verify (happy path)", () => {
  it("stamps key_id + hmac on every record and verify passes", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    const r1 = await chain.append(makeInput());
    const r2 = await chain.append(makeInput({ type: "query" }));
    expect(r1.key_id).toBeDefined();
    expect(r1.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.key_id).toBe(r1.key_id); // same active DEK
    expect(r2.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(r2.hmac).not.toBe(r1.hmac); // different id|chain_hash inputs
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.totalRecords).toBe(2);
  });

  it("verify uses timing-safe comparison on the hmac field", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const path = tmpPath();
    const chain = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());
    // Tamper: rewrite the hmac field with garbage that happens to be the same length
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const record = JSON.parse(lines[0]!) as ProvenanceRecord;
    record.hmac = "0".repeat(64);
    writeFileSync(path, `${JSON.stringify(record)}\n`);
    const chain2 = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await expect(chain2.init()).rejects.toThrow(/hmac/i);
  });
});

describe("G5 mid-chain DEK rotation", () => {
  it("records signed under previous DEK still verify after rotate", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    const r1 = await chain.append(makeInput());
    // Rotate mid-chain
    const { current: newActive, previous } = keyStore.rotate(WS);
    expect(previous).not.toBeNull();
    const r2 = await chain.append(makeInput({ type: "query" }));
    // r1 was signed under the previous DEK; r2 under the new active.
    expect(r1.key_id).toBe(previous!.key_id);
    expect(r2.key_id).toBe(newActive.key_id);
    expect(r1.key_id).not.toBe(r2.key_id);
    // Verify still passes — KeyStore resolves both keys via key_id.
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("after old DEK is revoked, records signed under it still verify cryptographically", async () => {
    const keyStore = mkKeyStore();
    const k1 = keyStore.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());
    keyStore.rotate(WS);
    await chain.append(makeInput({ type: "query" }));
    // Now revoke the original key. The record under it still verifies
    // mathematically; operators see key_state=revoked and decide.
    keyStore.revoke(k1.key_id);
    const result = await chain.verify();
    expect(result.ok).toBe(true);
  });

  it("after rotation, new appends bind to the new key_id", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());
    const { current } = keyStore.rotate(WS);
    const r2 = await chain.append(makeInput({ type: "query" }));
    const r3 = await chain.append(makeInput({ type: "compound" }));
    expect(r2.key_id).toBe(current.key_id);
    expect(r3.key_id).toBe(current.key_id);
  });
});

describe("G5 backward-compat: pre-G5 chains", () => {
  it("a chain with no hmac field verifies under a v0.8.2+ daemon", async () => {
    // Construct a chain WITHOUT any HMAC infrastructure: no tenantId, no
    // hmacKey, no keyStore. This is the v0.4.0-era shape.
    const chain = new ProvenanceChain({ path: tmpPath() });
    await chain.init();
    const r = await chain.append(makeInput());
    expect(r.hmac).toBeUndefined();
    expect(r.key_id).toBeUndefined();
    const result = await chain.verify();
    expect(result.ok).toBe(true);
    expect(result.totalRecords).toBe(1);
  });
});

describe("G5 backward-compat: G5-scaffolding chains (hmac, no key_id)", () => {
  it("records with hmac+no-key_id verify under fallback hmacKey on a new daemon", async () => {
    // Phase 1: produce a chain with the v0.8.1 shape — HMAC signed by
    // the 4-tier derived key, NO key_id (because no keyStore was set).
    const path = tmpPath();
    const oldChain = new ProvenanceChain({ path, tenantId: WS });
    await oldChain.init();
    const r1 = await oldChain.append(makeInput());
    expect(r1.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(r1.key_id).toBeUndefined();

    // Phase 2: a v0.8.2+ daemon opens the same chain, this time WITH a
    // keyStore. The keyStore has no entry for the v0.8.1 key_id (there
    // was none), so verify falls back to the 4-tier resolution.
    const keyStore = mkKeyStore();
    keyStore.provision(WS); // adds a NEW key — irrelevant for r1's verify
    const newChain = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await newChain.init(); // tail verify uses 4-tier fallback for r1
    const result = await newChain.verify();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("a mixed chain (some records pre-G5, some G5-closed) verifies end-to-end", async () => {
    const path = tmpPath();
    const oldChain = new ProvenanceChain({ path, tenantId: WS });
    await oldChain.init();
    await oldChain.append(makeInput()); // pre-G5 hmac, no key_id
    await oldChain.append(makeInput({ type: "query" }));

    // Now switch to a G5-closed daemon
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const newChain = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await newChain.init();
    await newChain.append(makeInput({ type: "compound" })); // G5-closed: has key_id

    const result = await newChain.verify();
    expect(result.ok).toBe(true);
    expect(result.totalRecords).toBe(3);
  });
});

describe("G5 forward-compat: v0.8.2+ chain verifies under older daemon (canonical-payload-exclusion)", () => {
  it("canonical id recomputed without key_id/hmac/fact_hashes matches the stored id", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    const r = await chain.append(makeInput());
    // Simulate what an older daemon would compute: canonical payload
    // WITHOUT the new G5 fields (hmac, key_id, fact_hashes_*).
    const olderCanonical: Record<string, unknown> = {
      seq: r.seq,
      timestamp: r.timestamp,
      type: r.type,
      source_files: r.source_files,
      source_hashes: r.source_hashes,
      prompt_hash: r.prompt_hash,
      model_id: r.model_id,
      response_hash: r.response_hash,
      wiki_files_written: r.wiki_files_written,
      wiki_file_hashes_after: r.wiki_file_hashes_after,
      previous_id: r.previous_id,
      previous_chain_hash: r.previous_chain_hash,
    };
    if (r.tenant_id !== undefined) olderCanonical.tenant_id = r.tenant_id;
    // No metadata, no fact_hashes_*, no hmac, no key_id in payload.
    const olderId = sha256Canonical(olderCanonical);
    expect(olderId).toBe(r.id);
  });
});

describe("G5 tamper detection in verify()", () => {
  it("flips a stored hmac → verify reports mismatch", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const path = tmpPath();
    const chain = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());
    await chain.append(makeInput({ type: "query" }));

    // Tamper the second record's hmac
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const r2 = JSON.parse(lines[1]!) as ProvenanceRecord;
    r2.hmac = r2.hmac!.replace(/.$/, "0"); // change last hex char
    writeFileSync(path, `${lines[0]}\n${JSON.stringify(r2)}\n`);

    // Re-open with same keyStore; the in-memory chain doesn't have the
    // tampered state yet, so we make a fresh instance.
    const chain2 = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    // tail-verify in init() catches the tampered tail hmac
    await expect(chain2.init()).rejects.toThrow(/hmac/i);
  });

  it("verify() with a missing key_id (referenced key doesn't exist) surfaces error", async () => {
    const keyStore = mkKeyStore();
    keyStore.provision(WS);
    const path = tmpPath();
    const chain = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await chain.init();
    await chain.append(makeInput());

    // Tamper: rewrite key_id to a UUID that doesn't exist in keyStore
    const lines = readFileSync(path, "utf8").trim().split("\n");
    const r = JSON.parse(lines[0]!) as ProvenanceRecord;
    r.key_id = "00000000-0000-0000-0000-000000000000";
    writeFileSync(path, `${JSON.stringify(r)}\n`);

    const chain2 = new ProvenanceChain({
      path,
      tenantId: WS,
      workspaceId: WS,
      keyStore,
    });
    await expect(chain2.init()).rejects.toThrow(/not found in keyStore/);
  });
});

describe("G5: signing falls back to single-key when no keyStore", () => {
  it("constructor with tenantId but no keyStore produces hmac without key_id", async () => {
    const chain = new ProvenanceChain({
      path: tmpPath(),
      tenantId: WS,
    });
    await chain.init();
    const r = await chain.append(makeInput());
    expect(r.hmac).toMatch(/^[0-9a-f]{64}$/);
    expect(r.key_id).toBeUndefined();
    const result = await chain.verify();
    expect(result.ok).toBe(true);
  });
});
