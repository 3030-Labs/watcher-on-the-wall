/**
 * File system utilities: atomic writes, directory scaffolding, path resolution.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Expand a leading `~` to the current user's home directory.
 */
export function expandHome(path: string): string {
  if (path.startsWith("~")) {
    return resolve(homedir(), path.slice(path.startsWith("~/") ? 2 : 1));
  }
  return path;
}

/**
 * Resolve a path against an optional base directory, expanding `~`.
 */
export function resolvePath(path: string, base?: string): string {
  const expanded = expandHome(path);
  if (isAbsolute(expanded)) return expanded;
  return resolve(base ?? process.cwd(), expanded);
}

/**
 * Ensure the directory at `dir` exists, creating it and all parents if needed.
 */
export function ensureDirSync(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * Async version of {@link ensureDirSync}.
 */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to a temp file in the same directory and rename.
 * This guarantees readers never see a partial file on POSIX systems.
 */
export function atomicWriteSync(filePath: string, contents: string | Buffer): void {
  ensureDirSync(dirname(filePath));
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmp, contents);
  renameSync(tmp, filePath);
}

/**
 * Async version of {@link atomicWriteSync}.
 */
export async function atomicWrite(filePath: string, contents: string | Buffer): Promise<void> {
  await ensureDir(dirname(filePath));
  const tmp = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, filePath);
}

/**
 * Read a UTF-8 file, returning null if it does not exist.
 */
export function readTextOrNull(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Async version of {@link readTextOrNull}.
 */
export async function readTextOrNullAsync(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Delete a file if it exists, otherwise no-op.
 */
export function removeIfExistsSync(filePath: string): void {
  if (existsSync(filePath)) {
    rmSync(filePath, { force: true });
  }
}

/**
 * Check if a path points to an existing file.
 */
export function fileExists(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Check if a path points to an existing directory.
 */
export function dirExists(dirPath: string): boolean {
  try {
    return statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}
