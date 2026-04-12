/**
 * Unit tests for utils/fs.ts: path resolution, atomic writes, existence checks.
 */
import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir, homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  atomicWrite,
  atomicWriteSync,
  dirExists,
  ensureDir,
  ensureDirSync,
  expandHome,
  fileExists,
  readTextOrNull,
  readTextOrNullAsync,
  removeIfExistsSync,
  resolvePath,
} from "../../src/utils/fs.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-fs-"));
}

describe("expandHome", () => {
  it("expands ~/ to the home directory", () => {
    const result = expandHome("~/foo/bar");
    expect(result.startsWith(homedir())).toBe(true);
    expect(result).toContain("foo/bar");
  });

  it("expands ~ alone", () => {
    const result = expandHome("~");
    expect(result).toBe(homedir());
  });

  it("leaves paths without ~ alone", () => {
    expect(expandHome("/absolute/path")).toBe("/absolute/path");
    expect(expandHome("relative/path")).toBe("relative/path");
  });
});

describe("resolvePath", () => {
  it("returns absolute paths unchanged", () => {
    const abs = "/tmp/foo";
    expect(resolvePath(abs)).toBe(abs);
  });

  it("resolves relative paths against the base dir", () => {
    const result = resolvePath("foo.txt", "/tmp/base");
    expect(result).toBe("/tmp/base/foo.txt");
  });

  it("expands home before resolving", () => {
    const result = resolvePath("~/foo.txt");
    expect(isAbsolute(result)).toBe(true);
    expect(result.startsWith(homedir())).toBe(true);
  });

  it("falls back to cwd when no base", () => {
    const result = resolvePath("foo.txt");
    expect(isAbsolute(result)).toBe(true);
  });
});

describe("ensureDir / ensureDirSync", () => {
  it("creates nested directories", () => {
    const root = tmp();
    const deep = join(root, "a/b/c/d");
    ensureDirSync(deep);
    expect(dirExists(deep)).toBe(true);
  });

  it("is idempotent", async () => {
    const root = tmp();
    const dir = join(root, "idempotent");
    await ensureDir(dir);
    await ensureDir(dir);
    expect(dirExists(dir)).toBe(true);
  });
});

describe("atomicWrite / atomicWriteSync", () => {
  it("writes the file with exact contents (sync)", () => {
    const root = tmp();
    const file = join(root, "out.txt");
    atomicWriteSync(file, "hello");
    expect(readFileSync(file, "utf8")).toBe("hello");
  });

  it("writes the file with exact contents (async)", async () => {
    const root = tmp();
    const file = join(root, "out.txt");
    await atomicWrite(file, "async-hello");
    expect(readFileSync(file, "utf8")).toBe("async-hello");
  });

  it("creates parent directories if missing", async () => {
    const root = tmp();
    const file = join(root, "nested/dir/out.txt");
    await atomicWrite(file, "data");
    expect(readFileSync(file, "utf8")).toBe("data");
  });

  it("does not leave .tmp files behind on success", async () => {
    const root = tmp();
    const file = join(root, "out.txt");
    await atomicWrite(file, "data");
    const leftovers = readdirSync(root).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });

  it("overwrites existing files atomically", async () => {
    const root = tmp();
    const file = join(root, "out.txt");
    await atomicWrite(file, "first");
    await atomicWrite(file, "second");
    expect(readFileSync(file, "utf8")).toBe("second");
  });
});

describe("readTextOrNull / readTextOrNullAsync", () => {
  it("returns file contents when present", async () => {
    const root = tmp();
    const file = join(root, "a.txt");
    writeFileSync(file, "abc");
    expect(readTextOrNull(file)).toBe("abc");
    expect(await readTextOrNullAsync(file)).toBe("abc");
  });

  it("returns null for missing files", async () => {
    expect(readTextOrNull("/nowhere/ghost.txt")).toBeNull();
    expect(await readTextOrNullAsync("/nowhere/ghost.txt")).toBeNull();
  });
});

describe("fileExists / dirExists", () => {
  it("distinguishes files from directories", () => {
    const root = tmp();
    const file = join(root, "f.txt");
    writeFileSync(file, "");
    expect(fileExists(file)).toBe(true);
    expect(dirExists(file)).toBe(false);
    expect(dirExists(root)).toBe(true);
    expect(fileExists(root)).toBe(false);
  });

  it("returns false for missing paths", () => {
    expect(fileExists("/nowhere/xx")).toBe(false);
    expect(dirExists("/nowhere/xx")).toBe(false);
  });
});

describe("removeIfExistsSync", () => {
  it("removes an existing file", () => {
    const root = tmp();
    const file = join(root, "to-remove.txt");
    writeFileSync(file, "x");
    removeIfExistsSync(file);
    expect(existsSync(file)).toBe(false);
  });

  it("is a no-op when the file does not exist", () => {
    removeIfExistsSync("/nowhere/x");
    // should not throw
  });
});

describe("fileExists / dirExists — EACCES", () => {
  it.skipIf(platform() === "win32")("fileExists throws on EACCES", () => {
    const root = tmp();
    const dir = join(root, "noperm");
    mkdirSync(dir);
    const file = join(dir, "secret.txt");
    writeFileSync(file, "data");
    chmodSync(dir, 0o000);
    try {
      expect(() => fileExists(file)).toThrow();
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it.skipIf(platform() === "win32")("dirExists throws on EACCES", () => {
    const root = tmp();
    const parent = join(root, "noperm-dir");
    mkdirSync(parent);
    const child = join(parent, "inner");
    mkdirSync(child);
    chmodSync(parent, 0o000);
    try {
      expect(() => dirExists(child)).toThrow();
    } finally {
      chmodSync(parent, 0o755);
    }
  });
});

describe("atomicWriteSync — temp file cleanup on rename failure", () => {
  it("cleans up temp file when rename fails", () => {
    const root = tmp();
    // Make the target an existing non-empty directory -- renameSync will throw
    // EISDIR (or ENOTDIR / ENOTEMPTY) when attempting to rename a regular file
    // over a directory, which exercises the finally cleanup branch.
    const target = join(root, "target-dir");
    mkdirSync(target);
    writeFileSync(join(target, "blocker.txt"), "x");

    expect(() => atomicWriteSync(target, "data")).toThrow();
    // Verify no .tmp files remain in the parent directory
    const leftovers = readdirSync(root).filter((f) => f.endsWith(".tmp"));
    expect(leftovers).toHaveLength(0);
  });
});
