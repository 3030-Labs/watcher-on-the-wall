/**
 * Unit tests for the KEK/DEK envelope encryption substrate.
 */
import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  generateDek,
  parseKek,
  readKekFromEnv,
  unwrapDek,
  wrapDek,
} from "../../../src/keys/envelope.js";

describe("parseKek", () => {
  it("accepts a 32-byte base64-encoded KEK", () => {
    const kek = randomBytes(32);
    const encoded = kek.toString("base64");
    const parsed = parseKek(encoded);
    expect(parsed.equals(kek)).toBe(true);
  });

  it("accepts a 32-byte hex-encoded KEK", () => {
    const kek = randomBytes(32);
    const encoded = kek.toString("hex");
    const parsed = parseKek(encoded);
    expect(parsed.equals(kek)).toBe(true);
  });

  it("throws on empty string", () => {
    expect(() => parseKek("")).toThrow(/empty/i);
  });

  it("throws on a 16-byte (too short) KEK", () => {
    const tooShort = randomBytes(16).toString("base64");
    expect(() => parseKek(tooShort)).toThrow(/32 bytes/);
  });

  it("throws on a 64-byte (too long) KEK", () => {
    const tooLong = randomBytes(64).toString("base64");
    expect(() => parseKek(tooLong)).toThrow(/32 bytes/);
  });

  it("throws on garbage input", () => {
    expect(() => parseKek("!!!not-a-valid-encoding!!!")).toThrow(/32 bytes/);
  });
});

describe("readKekFromEnv", () => {
  it("reads WOTW_WORKSPACE_KEK from a provided env object", () => {
    const kek = randomBytes(32);
    const env = { WOTW_WORKSPACE_KEK: kek.toString("base64") } as NodeJS.ProcessEnv;
    const parsed = readKekFromEnv(env);
    expect(parsed.equals(kek)).toBe(true);
  });

  it("throws when WOTW_WORKSPACE_KEK is unset", () => {
    expect(() => readKekFromEnv({} as NodeJS.ProcessEnv)).toThrow(/not set/i);
  });
});

describe("generateDek", () => {
  it("returns 32 random bytes", () => {
    const dek1 = generateDek();
    const dek2 = generateDek();
    expect(dek1.length).toBe(32);
    expect(dek2.length).toBe(32);
    expect(dek1.equals(dek2)).toBe(false);
  });
});

describe("wrap/unwrap round-trip", () => {
  it("recovers the same DEK bytes after wrap → unwrap", () => {
    const kek = randomBytes(32);
    const dek = generateDek();
    const env = wrapDek(dek, kek);
    const unwrapped = unwrapDek(env, kek);
    expect(unwrapped.equals(dek)).toBe(true);
  });

  it("produces different ciphertext for the same DEK on repeated wraps (random nonces)", () => {
    const kek = randomBytes(32);
    const dek = generateDek();
    const a = wrapDek(dek, kek);
    const b = wrapDek(dek, kek);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("auth tag is exactly 16 bytes (AES-GCM contract)", () => {
    const env = wrapDek(generateDek(), randomBytes(32));
    expect(env.auth_tag.length).toBe(16);
  });

  it("nonce is exactly 12 bytes", () => {
    const env = wrapDek(generateDek(), randomBytes(32));
    expect(env.nonce.length).toBe(12);
  });
});

describe("wrap/unwrap tamper detection", () => {
  it("unwrap throws when ciphertext is tampered", () => {
    const kek = randomBytes(32);
    const dek = generateDek();
    const env = wrapDek(dek, kek);
    const tampered = {
      ciphertext: Buffer.from(env.ciphertext),
      nonce: env.nonce,
      auth_tag: env.auth_tag,
    };
    tampered.ciphertext[0] ^= 0x01;
    expect(() => unwrapDek(tampered, kek)).toThrow();
  });

  it("unwrap throws when auth_tag is tampered", () => {
    const kek = randomBytes(32);
    const env = wrapDek(generateDek(), kek);
    const tampered = {
      ciphertext: env.ciphertext,
      nonce: env.nonce,
      auth_tag: Buffer.from(env.auth_tag),
    };
    tampered.auth_tag[0] ^= 0x01;
    expect(() => unwrapDek(tampered, kek)).toThrow();
  });

  it("unwrap throws when nonce is tampered", () => {
    const kek = randomBytes(32);
    const env = wrapDek(generateDek(), kek);
    const tampered = {
      ciphertext: env.ciphertext,
      nonce: Buffer.from(env.nonce),
      auth_tag: env.auth_tag,
    };
    tampered.nonce[0] ^= 0x01;
    expect(() => unwrapDek(tampered, kek)).toThrow();
  });

  it("unwrap throws when KEK is wrong", () => {
    const kekA = randomBytes(32);
    const kekB = randomBytes(32);
    const env = wrapDek(generateDek(), kekA);
    expect(() => unwrapDek(env, kekB)).toThrow();
  });
});

describe("wrap input validation", () => {
  it("rejects DEK of wrong length", () => {
    const kek = randomBytes(32);
    expect(() => wrapDek(randomBytes(16), kek)).toThrow(/32 bytes/);
    expect(() => wrapDek(randomBytes(64), kek)).toThrow(/32 bytes/);
  });

  it("rejects KEK of wrong length", () => {
    const dek = generateDek();
    expect(() => wrapDek(dek, randomBytes(16))).toThrow(/32 bytes/);
    expect(() => wrapDek(dek, randomBytes(64))).toThrow(/32 bytes/);
  });
});
