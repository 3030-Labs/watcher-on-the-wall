/**
 * Unit tests for cli/lib/vault-detect.ts: Obsidian vault registry parsing,
 * enclosing-vault walk, and the obsidian:// launcher.
 *
 * These tests never touch the real Obsidian registry — they always pass an
 * override registry path pointing at a fixture inside a tmp dir. The launch
 * test uses the test environment's actual platform; we only assert that the
 * helper returns boolean and never throws, not that Obsidian is installed.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findEnclosingVault,
  findObsidianVaults,
  obsidianOpenCommand,
  obsidianRegistryPath,
  openInObsidian,
} from "../../src/cli/lib/vault-detect.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-vault-detect-"));
}

describe("obsidianRegistryPath", () => {
  it("honors an explicit override", () => {
    const override = "/tmp/custom/obsidian.json";
    expect(obsidianRegistryPath(override)).toBe(override);
  });

  it("returns a non-empty default when no override is given", () => {
    const path = obsidianRegistryPath();
    expect(path.length).toBeGreaterThan(0);
    expect(path.endsWith("obsidian.json")).toBe(true);
  });
});

describe("findObsidianVaults", () => {
  it("returns an empty array when the registry file is missing", () => {
    const root = tmp();
    const registry = join(root, "does-not-exist.json");
    expect(findObsidianVaults(registry)).toEqual([]);
  });

  it("returns an empty array when the registry file is malformed JSON", () => {
    const root = tmp();
    const registry = join(root, "obsidian.json");
    writeFileSync(registry, "{ not valid json");
    expect(findObsidianVaults(registry)).toEqual([]);
  });

  it("parses a mock registry, filters nonexistent paths, and sorts by ts", () => {
    const root = tmp();
    const vaultA = join(root, "Alpha");
    const vaultB = join(root, "Beta");
    const vaultGhost = join(root, "Ghost"); // never created
    mkdirSync(vaultA);
    mkdirSync(vaultB);

    const registry = join(root, "obsidian.json");
    writeFileSync(
      registry,
      JSON.stringify({
        vaults: {
          aaa: { path: vaultA, ts: 1000, open: false },
          bbb: { path: vaultB, ts: 3000, open: true },
          ccc: { path: vaultGhost, ts: 9999, open: false },
          // Entry with missing path — should be skipped
          ddd: { ts: 5000 },
        },
      }),
    );

    const vaults = findObsidianVaults(registry);

    // ccc and ddd are filtered out — only Alpha and Beta survive.
    expect(vaults).toHaveLength(2);
    // Sorted by ts descending — Beta (3000) first.
    expect(vaults[0]!.name).toBe("Beta");
    expect(vaults[0]!.path).toBe(vaultB);
    expect(vaults[0]!.ts).toBe(3000);
    expect(vaults[0]!.open).toBe(true);
    expect(vaults[1]!.name).toBe("Alpha");
    expect(vaults[1]!.path).toBe(vaultA);
    expect(vaults[1]!.ts).toBe(1000);
    expect(vaults[1]!.open).toBe(false);
  });

  it("skips entries whose path points at a file rather than a directory", () => {
    const root = tmp();
    const vaultReal = join(root, "Real");
    const vaultFile = join(root, "not-a-dir.txt");
    mkdirSync(vaultReal);
    writeFileSync(vaultFile, "i am a file");

    const registry = join(root, "obsidian.json");
    writeFileSync(
      registry,
      JSON.stringify({
        vaults: {
          aaa: { path: vaultReal, ts: 1, open: false },
          bbb: { path: vaultFile, ts: 2, open: false },
        },
      }),
    );

    const vaults = findObsidianVaults(registry);
    expect(vaults).toHaveLength(1);
    expect(vaults[0]!.path).toBe(vaultReal);
  });
});

describe("findEnclosingVault", () => {
  it("finds a .obsidian directory one level up", () => {
    const root = tmp();
    const vault = join(root, "MyVault");
    const nested = join(vault, "notes", "deep");
    mkdirSync(join(vault, ".obsidian"), { recursive: true });
    mkdirSync(nested, { recursive: true });

    expect(findEnclosingVault(nested)).toBe(vault);
    expect(findEnclosingVault(vault)).toBe(vault);
  });

  it("returns null when no .obsidian exists in any parent", () => {
    const root = tmp();
    const nested = join(root, "nothing", "here");
    mkdirSync(nested, { recursive: true });
    // We stop at the filesystem root without finding .obsidian.
    expect(findEnclosingVault(nested)).toBeNull();
  });
});

describe("obsidianOpenCommand", () => {
  it("encodes the vault path into an obsidian:// URI", () => {
    const { command, args } = obsidianOpenCommand("/home/user/my vault");
    expect(command.length).toBeGreaterThan(0);
    const uri = args.find((a) => a.startsWith("obsidian://"));
    expect(uri).toBeDefined();
    expect(uri).toContain(encodeURIComponent("/home/user/my vault"));
  });
});

describe("openInObsidian", () => {
  it("returns false (and does not throw) when the launcher fails", async () => {
    // We pass a bogus path; on systems without the obsidian:// handler the
    // launcher command will still run and either exit 0 (xdg-open prints a
    // warning) or exit non-zero. We only assert that it never throws and
    // returns a boolean.
    const result = await openInObsidian("/this/path/does/not/exist");
    expect(typeof result).toBe("boolean");
  }, 10000);
});
