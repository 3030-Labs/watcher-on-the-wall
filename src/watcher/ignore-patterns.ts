/**
 * Ignore patterns for the file watcher. We mix defaults (dotfiles, OS junk,
 * temp files) with user-supplied globs from config.
 */
import { basename } from "node:path";

export const DEFAULT_IGNORES: readonly string[] = [
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/.*", // all dotfiles
  "**/*.swp",
  "**/*.swo",
  "**/*~",
  "**/*.tmp",
  "**/*.part",
  "**/node_modules/**",
  "**/.git/**",
  "**/.wotw*.tmp", // our own atomic-write staging files
];

/**
 * Return the merged list of ignore globs: defaults first, then user patterns.
 * Duplicates are removed preserving the first occurrence.
 */
export function resolveIgnores(userPatterns: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...DEFAULT_IGNORES, ...userPatterns]) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  }
  return out;
}

/**
 * Lightweight pre-filter applied inside event handlers — chokidar's glob
 * matcher handles most cases, but we still want to drop transient files
 * like ".foo.md.swp" that race in before the glob fires.
 */
export function shouldIgnoreBasename(name: string): boolean {
  const base = basename(name);
  if (base.startsWith(".")) return true;
  if (base.endsWith(".tmp") || base.endsWith(".part") || base.endsWith("~")) return true;
  if (base.endsWith(".swp") || base.endsWith(".swo")) return true;
  return false;
}
