/**
 * Storage quota enforcement. Walks raw/ + wiki/ content and rejects
 * writes that would exceed the tenant's storage cap.
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export class StorageAccountant {
  constructor(
    private readonly wikiRoot: string,
    private readonly limitBytes: number,
  ) {}

  /** Sum all file sizes under raw/ and wiki/ (not daemon state). */
  async currentUsageBytes(): Promise<number> {
    let total = 0;
    const rawDir = join(this.wikiRoot, "raw");
    const wikiDir = join(this.wikiRoot, "wiki");
    total += walkSize(rawDir);
    total += walkSize(wikiDir);
    return total;
  }

  /** Would adding `additionalBytes` exceed the limit? */
  async wouldExceed(additionalBytes: number): Promise<boolean> {
    const current = await this.currentUsageBytes();
    return current + additionalBytes > this.limitBytes;
  }

  /** Throw if adding `additionalBytes` would exceed the limit. */
  async checkOrThrow(additionalBytes: number): Promise<void> {
    const current = await this.currentUsageBytes();
    if (current + additionalBytes > this.limitBytes) {
      const usedGB = (current / 1024 ** 3).toFixed(2);
      const limitGB = (this.limitBytes / 1024 ** 3).toFixed(0);
      throw new Error(
        `Storage limit reached: using ${usedGB} GB of ${limitGB} GB. Free up space or upgrade your plan.`,
      );
    }
  }
}

/** Recursively sum file sizes in a directory. Returns 0 if dir doesn't exist. */
function walkSize(dir: string): number {
  let total = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      const st = statSync(full);
      if (st.isDirectory()) {
        total += walkSize(full);
      } else {
        total += st.size;
      }
    } catch {
      // Skip unreadable entries
    }
  }
  return total;
}
