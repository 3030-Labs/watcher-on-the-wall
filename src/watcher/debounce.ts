/**
 * Adaptive debounce batcher. Collects events until a quiet period is seen,
 * then flushes them as a batch. When events keep streaming in (a "burst")
 * the debounce window grows geometrically up to a ceiling. This lets us
 * batch huge drops without firing mid-copy, while still responding quickly
 * to single-file saves.
 *
 * Deletions (`pushDelete`) flow through the same timer and size caps as
 * adds — the flush handler receives both sets so the ingestion queue can
 * process adds first and deletions after (Feature 2: deletion handling).
 *
 * Integration contract:
 *   const batcher = new DebounceBatcher(opts, (adds, deletes) => onFlush(adds, deletes));
 *   batcher.push(path);            // an added / changed file
 *   batcher.pushDelete(path);      // a removed file
 *   await batcher.flushNow();      // force-flush (tests / shutdown)
 *   batcher.stop();                // cancel any pending timer
 */
export interface DebounceOptions {
  initialMs: number;
  maxMs: number;
  growthFactor: number;
  burstThreshold: number;
  maxBatchSize: number;
}

/**
 * Flush handler signature. `deletes` is always supplied (may be empty)
 * so the handler can implement a single "adds then deletes" path.
 */
export type FlushHandler = (paths: string[], deletes: string[]) => void | Promise<void>;

export class DebounceBatcher {
  private readonly opts: DebounceOptions;
  private readonly onFlush: FlushHandler;
  private pending = new Set<string>();
  private pendingDeletes = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private currentWait: number;
  private eventsSinceLastFlush = 0;
  private stopped = false;

  constructor(opts: DebounceOptions, onFlush: FlushHandler) {
    this.opts = opts;
    this.onFlush = onFlush;
    this.currentWait = opts.initialMs;
  }

  /** Add a path to the pending set and (re)arm the timer. */
  push(path: string): void {
    if (this.stopped) return;
    // If the path was previously marked for deletion in this same window,
    // the add supersedes the delete (file was re-created).
    this.pendingDeletes.delete(path);
    this.pending.add(path);
    this.registerEvent();
  }

  /**
   * Mark a path as deleted. Flows through the same timer/burst/size
   * machinery as {@link push} so an add+delete combo lands in the same
   * flush. If the path was previously pending an add in this window, the
   * delete supersedes it (file was added then removed before flush).
   */
  pushDelete(path: string): void {
    if (this.stopped) return;
    this.pending.delete(path);
    this.pendingDeletes.add(path);
    this.registerEvent();
  }

  /** Flush immediately, cancelling any pending timer. */
  async flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.size === 0 && this.pendingDeletes.size === 0) return;
    const paths = [...this.pending].sort();
    const deletes = [...this.pendingDeletes].sort();
    this.pending.clear();
    this.pendingDeletes.clear();
    this.eventsSinceLastFlush = 0;
    this.currentWait = this.opts.initialMs; // reset back to baseline
    await this.onFlush(paths, deletes);
  }

  /** Permanently stop the batcher. Cancels any pending flush. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending.clear();
    this.pendingDeletes.clear();
  }

  /** Total pending event count (adds + deletes). */
  size(): number {
    return this.pending.size + this.pendingDeletes.size;
  }

  /** Current debounce wait window in milliseconds. */
  currentWindow(): number {
    return this.currentWait;
  }

  private registerEvent(): void {
    this.eventsSinceLastFlush += 1;

    if (this.eventsSinceLastFlush >= this.opts.burstThreshold) {
      // burst detected → grow the wait window
      this.currentWait = Math.min(
        this.opts.maxMs,
        Math.round(this.currentWait * this.opts.growthFactor),
      );
    }

    // Hard cap on combined add+delete batch size.
    if (this.pending.size + this.pendingDeletes.size >= this.opts.maxBatchSize) {
      void this.flushNow();
      return;
    }

    this.arm();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushNow();
    }, this.currentWait);
    // intentional: do NOT unref — we want the flush to keep the event loop alive
  }
}
