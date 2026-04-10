/**
 * Git utilities wrapping simple-git for initialization, commits, and log inspection.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Check whether a directory already contains a `.git` folder.
 */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, ".git"));
}

/**
 * Return a SimpleGit handle bound to a given directory.
 */
export function git(dir: string): SimpleGit {
  return simpleGit({ baseDir: dir });
}

/**
 * Initialize a git repo in `dir` if one does not already exist.
 * Creates an initial empty commit so subsequent commits have a parent.
 */
export async function ensureGitRepo(
  dir: string,
  initialMessage = "chore: wotw init",
): Promise<void> {
  if (isGitRepo(dir)) return;
  const g = git(dir);
  await g.init();
  // Configure identity locally if none is set globally, so init commits don't fail.
  try {
    const name = (await g.getConfig("user.name")).value;
    const email = (await g.getConfig("user.email")).value;
    if (!name) await g.addConfig("user.name", "watcher-on-the-wall", false, "local");
    if (!email) await g.addConfig("user.email", "wotw@localhost", false, "local");
  } catch {
    await g.addConfig("user.name", "watcher-on-the-wall", false, "local");
    await g.addConfig("user.email", "wotw@localhost", false, "local");
  }
  await g.add(".");
  await g.commit(initialMessage, { "--allow-empty": null });
}

/**
 * Stage all and commit with a message. Silently no-op if nothing to commit.
 * When `paths` is provided, only those paths are staged (relative to `dir`);
 * otherwise the full working tree is staged.
 */
export async function commitAll(
  dir: string,
  message: string,
  paths?: string[],
): Promise<string | null> {
  if (!isGitRepo(dir)) return null;
  const g = git(dir);
  if (paths && paths.length > 0) {
    await g.add(paths);
  } else {
    await g.add(".");
  }
  const status = await g.status();
  if (status.files.length === 0) return null;
  const result = await g.commit(message);
  return result.commit || null;
}
