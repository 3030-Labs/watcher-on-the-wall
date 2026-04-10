/**
 * Unit tests for provenance/hash.ts — the pure cryptographic primitives
 * underpinning the provenance chain. These must be deterministic, order-
 * independent (for canonical JSON), and stable across restarts.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GENESIS_HASH,
  canonicalJson,
  sha256Canonical,
  sha256File,
  sha256Files,
  sha256Hex,
} from "../../src/provenance/hash.js";

describe("GENESIS_HASH", () => {
  it("is 64 hex zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
    expect(GENESIS_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalJson", () => {
  it("produces deterministic output regardless of key insertion order", () => {
    const a = canonicalJson({ b: 2, a: 1, c: 3 });
    const b = canonicalJson({ c: 3, a: 1, b: 2 });
    const c = canonicalJson({ a: 1, b: 2, c: 3 });
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(`{"a":1,"b":2,"c":3}`);
  });

  it("recursively sorts nested object keys", () => {
    const result = canonicalJson({ outer: { z: 1, a: 2 } });
    expect(result).toBe(`{"outer":{"a":2,"z":1}}`);
  });

  it("preserves array element order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles null, numbers, strings, and booleans", () => {
    expect(canonicalJson({ n: null, x: 1, s: "hi", b: true })).toBe(
      `{"b":true,"n":null,"s":"hi","x":1}`,
    );
  });

  it("escapes special characters in strings", () => {
    const result = canonicalJson({ s: 'hello "world"\n' });
    expect(result).toContain('\\"world\\"');
    expect(result).toContain("\\n");
  });
});

describe("sha256Hex", () => {
  it("matches known vector for empty string", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("matches known vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("accepts Buffer input", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("returns 64-char lowercase hex", () => {
    const h = sha256Hex("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("sha256Canonical", () => {
  it("is stable across reorderings", () => {
    const a = sha256Canonical({ x: 1, y: 2 });
    const b = sha256Canonical({ y: 2, x: 1 });
    expect(a).toBe(b);
  });

  it("differs for different content", () => {
    expect(sha256Canonical({ x: 1 })).not.toBe(sha256Canonical({ x: 2 }));
  });
});

describe("sha256File", () => {
  it("hashes file contents correctly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-hash-"));
    const f = join(dir, "test.txt");
    writeFileSync(f, "abc");
    const h = await sha256File(f);
    expect(h).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns null for missing files", async () => {
    const h = await sha256File("/nonexistent/definitely/not/a/file.txt");
    expect(h).toBeNull();
  });
});

describe("sha256Files", () => {
  it("returns a map from path to hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-hash-"));
    const f1 = join(dir, "a.txt");
    const f2 = join(dir, "b.txt");
    writeFileSync(f1, "abc");
    writeFileSync(f2, "");
    const map = await sha256Files([f1, f2]);
    expect(map[f1]).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(map[f2]).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("omits missing files from the result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-hash-"));
    const f = join(dir, "real.txt");
    writeFileSync(f, "ok");
    const missing = join(dir, "ghost.txt");
    const map = await sha256Files([f, missing]);
    expect(map[f]).toBeDefined();
    expect(map[missing]).toBeUndefined();
  });
});
