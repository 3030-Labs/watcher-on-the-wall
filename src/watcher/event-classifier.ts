/**
 * Classify chokidar events into high-level ingestion intents.
 *
 *   - A newly-created file that has never been seen before → "new"
 *   - A modified file whose hash changed → "update"
 *   - An unchanged file (saved but identical bytes) → "noop"
 *   - A deleted file → "removed"
 *
 * The classifier is backed by an in-memory map of absolute path → sha256.
 * Hashes are computed lazily; callers pass in file contents.
 */
import { sha256 } from "../provenance/hash.js";

export type ClassificationIntent = "new" | "update" | "noop" | "removed";

export interface Classification {
  intent: ClassificationIntent;
  path: string;
  previousHash: string | null;
  currentHash: string | null;
}

export class EventClassifier {
  private readonly hashes = new Map<string, string>();

  /** Seed the classifier from an initial scan. */
  seed(path: string, contents: string | Buffer): void {
    this.hashes.set(path, sha256(contents));
  }

  /** Forget everything. */
  reset(): void {
    this.hashes.clear();
  }

  /**
   * Classify an add / change event. Returns "noop" if the file contents
   * are byte-identical to the previously recorded hash.
   */
  classifyAddOrChange(path: string, contents: string | Buffer): Classification {
    const currentHash = sha256(contents);
    const previousHash = this.hashes.get(path) ?? null;
    this.hashes.set(path, currentHash);
    if (previousHash === null) {
      return { intent: "new", path, previousHash, currentHash };
    }
    if (previousHash === currentHash) {
      return { intent: "noop", path, previousHash, currentHash };
    }
    return { intent: "update", path, previousHash, currentHash };
  }

  /** Classify a removal event. */
  classifyRemove(path: string): Classification {
    const previousHash = this.hashes.get(path) ?? null;
    this.hashes.delete(path);
    return { intent: "removed", path, previousHash, currentHash: null };
  }

  /** Number of files currently tracked. */
  size(): number {
    return this.hashes.size;
  }
}
