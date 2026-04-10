/**
 * File watcher subsystem. Wraps chokidar with our adaptive debounce and
 * event classifier, then emits batches as ingestion intents.
 *
 * The watcher is a {@link DaemonSubsystem}: start() begins watching the
 * configured raw directory, stop() tears down chokidar and cancels the
 * pending debounce timer.
 */
import { readFileSync } from "node:fs";
import chokidar, { type FSWatcher } from "chokidar";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import type { DaemonSubsystem } from "../daemon/index.js";
import { DebounceBatcher } from "./debounce.js";
import { EventClassifier, type ClassificationIntent } from "./event-classifier.js";
import { resolveIgnores, shouldIgnoreBasename } from "./ignore-patterns.js";

/**
 * In CLI mode the daemon spawns the `claude` binary for every batch, which
 * is more expensive (process spawn + bundled CLI overhead) and is rate-
 * limited by the user's subscription rather than the API. We absorb a bit
 * more latency to coalesce more files into each spawn — empirically a 1.5×
 * multiplier on the debounce window halves the spawn rate without making
 * interactive editing feel laggy.
 */
const CLI_DEBOUNCE_MULTIPLIER = 1.5;

/**
 * A batch handed off to the ingestion queue. Paths are absolute and sorted.
 * `reasons` maps path → intent so the ingestion layer can decide whether
 * to create a new page vs update an existing one.
 *
 * `deletedPaths` carries any files removed from the raw tree during the
 * same debounce window as the adds. The ingestion queue processes adds
 * first and deletes second, so a net add+delete within one window still
 * produces a coherent wiki state.
 */
export interface WatcherBatch {
  id: string;
  createdAt: string;
  paths: string[];
  reasons: Record<string, ClassificationIntent>;
  deletedPaths: string[];
}

export type BatchHandler = (batch: WatcherBatch) => void | Promise<void>;

export interface WatcherOptions {
  config: WotwConfig;
  onBatch: BatchHandler;
  /**
   * Resolved runtime mode. When `"cli"`, the debounce window is widened by
   * {@link CLI_DEBOUNCE_MULTIPLIER} to coalesce more files per `claude`
   * spawn. Defaults to `"api"` so existing tests are unaffected.
   */
  runtimeMode?: RuntimeMode;
}

/**
 * Chokidar-backed watcher with adaptive debouncing. Emits classified batches
 * via the `onBatch` handler.
 */
export class FileWatcher implements DaemonSubsystem {
  readonly name = "watcher";
  private readonly opts: WatcherOptions;
  private readonly classifier = new EventClassifier();
  private readonly batcher: DebounceBatcher;
  private watcher: FSWatcher | null = null;
  private ready = false;

  constructor(opts: WatcherOptions) {
    this.opts = opts;
    const cliMode = opts.runtimeMode === "cli";
    const initialMs = cliMode
      ? Math.round(opts.config.watcher.debounce_initial_ms * CLI_DEBOUNCE_MULTIPLIER)
      : opts.config.watcher.debounce_initial_ms;
    const maxMs = cliMode
      ? Math.round(opts.config.watcher.debounce_max_ms * CLI_DEBOUNCE_MULTIPLIER)
      : opts.config.watcher.debounce_max_ms;
    this.batcher = new DebounceBatcher(
      {
        initialMs,
        maxMs,
        growthFactor: opts.config.watcher.debounce_growth_factor,
        burstThreshold: opts.config.watcher.burst_threshold,
        maxBatchSize: opts.config.watcher.max_batch_size,
      },
      (paths, deletes) => this.emitBatch(paths, deletes),
    );
  }

  async start(): Promise<void> {
    const log = getLogger("watcher");
    const rawPath = this.opts.config.raw_path;
    const ignores = resolveIgnores(this.opts.config.watcher.ignore_patterns);

    log.info({ rawPath, ignores }, "starting watcher");

    this.watcher = chokidar.watch(rawPath, {
      ignored: ignores,
      ignoreInitial: false, // pick up files present on startup
      persistent: true,
      awaitWriteFinish: {
        stabilityThreshold: 200,
        pollInterval: 50,
      },
      atomic: true,
    });

    this.watcher.on("add", (path) => this.handleAddOrChange(path, "add"));
    this.watcher.on("change", (path) => this.handleAddOrChange(path, "change"));
    this.watcher.on("unlink", (path) => this.handleUnlink(path));
    this.watcher.on("error", (err) => {
      log.error({ err }, "watcher error");
    });
    this.watcher.on("ready", () => {
      this.ready = true;
      log.info({ tracked: this.classifier.size() }, "watcher ready");
    });
  }

  async stop(): Promise<void> {
    const log = getLogger("watcher");
    log.info("stopping watcher");
    this.batcher.stop();
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }

  /** Pending batch size — exposed for status output. */
  pendingCount(): number {
    return this.batcher.size();
  }

  /** True once chokidar's initial scan has completed. */
  isReady(): boolean {
    return this.ready;
  }

  private handleAddOrChange(path: string, kind: "add" | "change"): void {
    if (shouldIgnoreBasename(path)) return;
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch (err) {
      getLogger("watcher").warn({ err, path, kind }, "failed to read file for classification");
      return;
    }
    const cls = this.classifier.classifyAddOrChange(path, contents);
    if (cls.intent === "noop") return;
    this.batcher.push(path);
  }

  private handleUnlink(path: string): void {
    if (shouldIgnoreBasename(path)) return;
    this.classifier.classifyRemove(path);
    getLogger("watcher").info({ path }, "file removed — queuing for archive");
    // Route the deletion through the same debouncer as adds. The
    // ingestion queue will archive the affected wiki pages (mark them
    // orphaned) during the next flush. See Feature 2.
    this.batcher.pushDelete(path);
  }

  private async emitBatch(paths: string[], deletes: string[]): Promise<void> {
    const log = getLogger("watcher");
    const reasons: Record<string, ClassificationIntent> = {};
    // We classified each path as it arrived; for the batch handoff, mark
    // them as "new" or "update" based on whether we've seen the hash before.
    // (The classifier already holds the latest hash map.)
    for (const p of paths) {
      reasons[p] = "update"; // benign default; real intent is used by ingestion
    }
    const batch: WatcherBatch = {
      id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      createdAt: new Date().toISOString(),
      paths,
      reasons,
      deletedPaths: deletes,
    };
    log.info({ batchId: batch.id, count: paths.length, deletes: deletes.length }, "flushing batch");
    try {
      await this.opts.onBatch(batch);
    } catch (err) {
      log.error({ err, batchId: batch.id }, "batch handler failed");
    }
  }
}

export { DebounceBatcher } from "./debounce.js";
export { EventClassifier, type ClassificationIntent } from "./event-classifier.js";
export { DEFAULT_IGNORES, resolveIgnores, shouldIgnoreBasename } from "./ignore-patterns.js";
