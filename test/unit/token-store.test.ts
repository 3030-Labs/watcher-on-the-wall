/**
 * Unit tests for TokenStore: load/save, addUser, revokeUser, authenticate.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../../src/multi-user/token-store.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-token-"));
}

describe("TokenStore.load", () => {
  it("creates an empty store when tokens.json does not exist", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    expect(store.size()).toBe(0);
    expect(store.listUsers()).toEqual([]);
  });

  it("loads an existing tokens.json file", () => {
    const dir = tmpDir();
    const file = join(dir, "tokens.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        tokens: {
          wotw_abc: { user: "alice", created: "2026-04-07T00:00:00.000Z" },
          wotw_def: { user: "bob", created: "2026-04-07T00:00:00.000Z" },
        },
      }),
    );
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    expect(store.size()).toBe(2);
    expect(store.authenticate("wotw_abc")).toEqual({ user: "alice" });
    expect(store.authenticate("wotw_def")).toEqual({ user: "bob" });
  });

  it("handles malformed JSON structure gracefully", () => {
    const dir = tmpDir();
    writeFileSync(join(dir, "tokens.json"), JSON.stringify({ nope: true }));
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    expect(store.size()).toBe(0);
  });
});

describe("TokenStore.addUser", () => {
  it("generates a token prefixed with wotw_", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    const token = store.addUser("alice");
    expect(token).toMatch(/^wotw_[0-9a-f]{64}$/);
  });

  it("persists to disk", () => {
    const dir = tmpDir();
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    const token = store.addUser("alice");
    const raw = readFileSync(join(dir, "tokens.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      version: number;
      tokens: Record<string, { user: string; created: string }>;
    };
    expect(parsed.version).toBe(1);
    expect(parsed.tokens[token]).toBeDefined();
    expect(parsed.tokens[token]!.user).toBe("alice");
  });

  it("issuing a new token for the same user revokes the old one", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    const t1 = store.addUser("alice");
    const t2 = store.addUser("alice");
    expect(t1).not.toBe(t2);
    expect(store.authenticate(t1)).toBeNull();
    expect(store.authenticate(t2)).toEqual({ user: "alice" });
    expect(store.size()).toBe(1);
  });

  it("supports multiple distinct users", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    const a = store.addUser("alice");
    const b = store.addUser("bob");
    expect(store.size()).toBe(2);
    expect(store.authenticate(a)).toEqual({ user: "alice" });
    expect(store.authenticate(b)).toEqual({ user: "bob" });
  });

  it("rejects empty user names", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    expect(() => store.addUser("")).toThrow(/non-empty/);
    expect(() => store.addUser("   ")).toThrow(/non-empty/);
  });

  it("trims whitespace from user names", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    store.addUser("  alice  ");
    expect(store.listUsers().map((u) => u.user)).toEqual(["alice"]);
  });
});

describe("TokenStore.authenticate", () => {
  it("returns null for empty token", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    expect(store.authenticate("")).toBeNull();
  });

  it("returns null for unknown token", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    store.addUser("alice");
    expect(store.authenticate("wotw_nope")).toBeNull();
  });
});

describe("TokenStore.revokeToken", () => {
  it("removes a known token and returns true", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    const tok = store.addUser("alice");
    expect(store.revokeToken(tok)).toBe(true);
    expect(store.authenticate(tok)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("returns false for unknown token", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    expect(store.revokeToken("wotw_fake")).toBe(false);
  });
});

describe("TokenStore.revokeUser", () => {
  it("removes all tokens for a user and returns the count", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    store.addUser("alice");
    store.addUser("bob");
    const count = store.revokeUser("alice");
    expect(count).toBe(1);
    expect(store.size()).toBe(1);
    expect(store.listUsers().map((u) => u.user)).toEqual(["bob"]);
  });

  it("returns 0 when user is not found", () => {
    const store = new TokenStore({ workspacesDir: tmpDir() });
    store.load();
    expect(store.revokeUser("ghost")).toBe(0);
  });
});

describe("TokenStore persistence", () => {
  it("survives a reload cycle", () => {
    const dir = tmpDir();
    const store1 = new TokenStore({ workspacesDir: dir });
    store1.load();
    const tok = store1.addUser("alice");

    const store2 = new TokenStore({ workspacesDir: dir });
    store2.load();
    expect(store2.size()).toBe(1);
    expect(store2.authenticate(tok)).toEqual({ user: "alice" });
  });

  it("clear() wipes all tokens", () => {
    const dir = tmpDir();
    const store = new TokenStore({ workspacesDir: dir });
    store.load();
    store.addUser("alice");
    store.addUser("bob");
    store.clear();
    expect(store.size()).toBe(0);

    const reload = new TokenStore({ workspacesDir: dir });
    reload.load();
    expect(reload.size()).toBe(0);
  });
});
