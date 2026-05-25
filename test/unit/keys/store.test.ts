/**
 * Unit tests for the SQLite-backed KeyStore.
 *
 * Covers: schema migration, provisioning, active-key lookup, key_id
 * resolution across states, rotation FSM, archive, revoke, and the
 * one-active-per-workspace invariant.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { KeyStore } from "../../../src/keys/store.js";

function mkStore(): KeyStore {
  const kek = randomBytes(32);
  return new KeyStore({ path: ":memory:", kek, inMemory: true });
}

const WS = "tenant-aaaa-1111";

describe("KeyStore.migrate", () => {
  it("migrates a fresh DB to schema version 1", () => {
    const store = mkStore();
    expect(store.schemaVersion()).toBe(1);
    store.close();
  });

  it("is idempotent on repeat construction", () => {
    const kek = randomBytes(32);
    const a = new KeyStore({ path: ":memory:", kek, inMemory: true });
    expect(a.schemaVersion()).toBe(1);
    a.close();
    const b = new KeyStore({ path: ":memory:", kek, inMemory: true });
    expect(b.schemaVersion()).toBe(1);
    b.close();
  });
});

describe("KeyStore.provision", () => {
  it("provisions a new active DEK", () => {
    const store = mkStore();
    const resolved = store.provision(WS);
    expect(resolved.key_state).toBe("active");
    expect(resolved.workspace_id).toBe(WS);
    expect(resolved.dek.length).toBe(32);
    expect(resolved.key_id).toMatch(/^[0-9a-f-]{36}$/);
    store.close();
  });

  it("refuses to provision when an active DEK already exists", () => {
    const store = mkStore();
    store.provision(WS);
    expect(() => store.provision(WS)).toThrow(/already has an active key/);
    store.close();
  });

  it("DEK bytes survive a re-decrypt via resolveById", () => {
    const store = mkStore();
    const provisioned = store.provision(WS);
    const resolved = store.resolveById(provisioned.key_id);
    expect(resolved).not.toBeNull();
    expect(resolved!.dek.equals(provisioned.dek)).toBe(true);
    store.close();
  });
});

describe("KeyStore.active", () => {
  it("returns null when no active key", () => {
    const store = mkStore();
    expect(store.active(WS)).toBeNull();
    store.close();
  });

  it("returns the active key after provision", () => {
    const store = mkStore();
    const provisioned = store.provision(WS);
    const active = store.active(WS);
    expect(active).not.toBeNull();
    expect(active!.key_id).toBe(provisioned.key_id);
    expect(active!.dek.equals(provisioned.dek)).toBe(true);
    store.close();
  });

  it("isolates workspaces", () => {
    const store = mkStore();
    store.provision("ws-a");
    expect(store.active("ws-b")).toBeNull();
    store.close();
  });
});

describe("KeyStore.resolveById", () => {
  it("returns null for unknown key_id", () => {
    const store = mkStore();
    expect(store.resolveById("00000000-0000-0000-0000-000000000000")).toBeNull();
    store.close();
  });

  it("resolves active, rotating, archived, and revoked keys all the same way", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    // k1 → rotating after rotation
    const { current: k2 } = store.rotate(WS);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("rotating");
    expect(store.resolveById(k2.key_id)?.key_state).toBe("active");
    // archive k1
    expect(store.archive(k1.key_id)).toBe(true);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
    // revoke k2
    expect(store.revoke(k2.key_id)).toBe(true);
    expect(store.resolveById(k2.key_id)?.key_state).toBe("revoked");
    store.close();
  });
});

describe("KeyStore.rotate", () => {
  it("provisions a new active and transitions previous to rotating", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    const result = store.rotate(WS);
    expect(result.previous).not.toBeNull();
    expect(result.previous!.key_id).toBe(k1.key_id);
    expect(result.previous!.key_state).toBe("rotating");
    expect(result.current.key_state).toBe("active");
    expect(result.current.key_id).not.toBe(k1.key_id);
    expect(result.current.dek.equals(k1.dek)).toBe(false);
    store.close();
  });

  it("rotation with no prior active key still provisions a new one", () => {
    const store = mkStore();
    const result = store.rotate(WS);
    expect(result.previous).toBeNull();
    expect(result.current.key_state).toBe("active");
    store.close();
  });

  it("after rotation the previous DEK is still resolvable for verify", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS);
    const resolved = store.resolveById(k1.key_id);
    expect(resolved).not.toBeNull();
    expect(resolved!.dek.equals(k1.dek)).toBe(true);
    expect(resolved!.key_state).toBe("rotating");
    store.close();
  });

  it("countByState reflects the rotation correctly", () => {
    const store = mkStore();
    store.provision(WS);
    store.rotate(WS);
    const counts = store.countByState(WS);
    expect(counts.active).toBe(1);
    expect(counts.rotating).toBe(1);
    expect(counts.archived).toBe(0);
    expect(counts.revoked).toBe(0);
    store.close();
  });
});

describe("KeyStore.archive", () => {
  it("transitions rotating → archived", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS);
    expect(store.archive(k1.key_id)).toBe(true);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("archived");
    store.close();
  });

  it("is a no-op on already-archived keys", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS);
    store.archive(k1.key_id);
    expect(store.archive(k1.key_id)).toBe(false);
    store.close();
  });

  it("does not transition active keys (only rotating)", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    expect(store.archive(k1.key_id)).toBe(false);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("active");
    store.close();
  });
});

describe("KeyStore.revoke", () => {
  it("revokes an active key", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    expect(store.revoke(k1.key_id)).toBe(true);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("revoked");
    store.close();
  });

  it("revokes a rotating key", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.rotate(WS);
    expect(store.revoke(k1.key_id)).toBe(true);
    expect(store.resolveById(k1.key_id)?.key_state).toBe("revoked");
    store.close();
  });

  it("is a no-op on already-revoked keys", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.revoke(k1.key_id);
    expect(store.revoke(k1.key_id)).toBe(false);
    store.close();
  });
});

describe("KeyStore one-active-per-workspace invariant", () => {
  it("after revoke, can provision a new active", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    store.revoke(k1.key_id);
    const k2 = store.provision(WS);
    expect(k2.key_state).toBe("active");
    expect(k2.key_id).not.toBe(k1.key_id);
    store.close();
  });

  it("after rotate, cannot provision another (would violate invariant)", () => {
    const store = mkStore();
    store.provision(WS);
    store.rotate(WS); // produces new active, previous → rotating
    // Now there's already an active; provision should refuse
    expect(() => store.provision(WS)).toThrow(/already has an active key/);
    store.close();
  });
});

describe("KeyStore.listAll", () => {
  it("returns rows in created_at order", () => {
    const store = mkStore();
    const k1 = store.provision(WS);
    // small delay to ensure timestamps differ
    const k2 = store.rotate(WS).current;
    const rows = store.listAll(WS);
    expect(rows.length).toBe(2);
    expect(rows[0]!.key_id).toBe(k1.key_id);
    expect(rows[1]!.key_id).toBe(k2.key_id);
    store.close();
  });
});

describe("KeyStore tamper resistance via envelope", () => {
  it("resolveById throws if encrypted_dek is tampered", () => {
    const kek = randomBytes(32);
    const store = new KeyStore({ path: ":memory:", kek, inMemory: true });
    const k1 = store.provision(WS);
    // Reach into the underlying DB and flip a bit in the ciphertext.
    // Use raw SQL since the public API doesn't allow tampering.
    // @ts-expect-error — access private db for the tamper test
    const db = store["db"];
    db.prepare("UPDATE workspace_keys SET encrypted_dek = ? WHERE key_id = ?").run(
      Buffer.from("tampered_______________________"),
      k1.key_id,
    );
    // Cache miss on a new lookup — force re-decrypt.
    // @ts-expect-error — access private cache for the tamper test
    store["dekCache"].clear();
    expect(() => store.resolveById(k1.key_id)).toThrow();
    store.close();
  });
});
