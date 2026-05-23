import { describe, expect, it } from "vitest";
import { isBlockedIp, safeFetchToFile, SafeFetchError } from "../../../src/server/safe-fetch.js";
import { mkdtemp, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("isBlockedIp — SSRF defense (review item 49)", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "224.0.0.1",
    "239.255.255.250",
  ])("blocks IPv4 %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "104.18.32.7", "172.32.0.1", "100.63.255.255"])(
    "allows public IPv4 %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );

  it.each([
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
  ])("blocks IPv6 %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["2606:4700:4700::1111", "2001:4860:4860::8888"])("allows public IPv6 %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("rejects garbage as blocked (fail closed)", () => {
    expect(isBlockedIp("not-an-ip")).toBe(true);
    expect(isBlockedIp("999.999.999.999")).toBe(true);
    expect(isBlockedIp("")).toBe(true);
  });
});

describe("safeFetchToFile — review item 49 layered SSRF defenses", () => {
  async function makeTmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "safe-fetch-test-"));
    return join(dir, "out.bin");
  }

  it("rejects non-https schemes", async () => {
    const target = await makeTmp();
    await expect(
      safeFetchToFile("http://example.com/x", { targetPath: target }),
    ).rejects.toMatchObject({ code: "INVALID_SCHEME" });
  });

  it("rejects unparseable URLs", async () => {
    const target = await makeTmp();
    await expect(safeFetchToFile("not a url", { targetPath: target })).rejects.toMatchObject({
      code: "INVALID_URL",
    });
  });

  it("rejects loopback hostname (resolved IP is blocked)", async () => {
    const target = await makeTmp();
    await expect(
      safeFetchToFile("https://localhost/x", { targetPath: target }),
    ).rejects.toMatchObject({ code: "PRIVATE_IP_BLOCKED" });
  });

  it("rejects IMDS host (169.254.169.254) — AWS/GCP metadata oracle", async () => {
    const target = await makeTmp();
    await expect(
      safeFetchToFile("https://169.254.169.254/latest/meta-data/", { targetPath: target }),
    ).rejects.toMatchObject({ code: "PRIVATE_IP_BLOCKED" });
  });

  it("rejects host that fails hostname allowlist", async () => {
    const target = await makeTmp();
    await expect(
      safeFetchToFile("https://example.com/x", {
        targetPath: target,
        hostnameAllowlist: [".supabase.co"],
      }),
    ).rejects.toMatchObject({ code: "HOSTNAME_NOT_ALLOWED" });
  });

  it("throws SafeFetchError (not raw err.message)", async () => {
    const target = await makeTmp();
    try {
      await safeFetchToFile("https://127.0.0.1/x", { targetPath: target });
      expect.fail("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect((e as SafeFetchError).code).toBe("PRIVATE_IP_BLOCKED");
    }
  });

  it("does not leave a partial file when failing pre-fetch", async () => {
    const target = await makeTmp();
    await expect(safeFetchToFile("http://example.com/x", { targetPath: target })).rejects.toThrow();
    await expect(stat(target)).rejects.toThrow();
  });
});
