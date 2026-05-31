/**
 * RedactionEmitWorker — daemon subsystem that drains pending redaction
 * events from the SQLite queue and POSTs batches to wotw-cloud's
 * `/api/internal/redaction-log` endpoint (FEATURE-PASS-011 / PASS-024
 * downstream).
 *
 * Lifecycle (DaemonSubsystem contract):
 *   - start(): immediate first-tick drain + schedule periodic ticks.
 *     Offline mode (sink is null) → log once + remain a no-op.
 *   - stop(): clear timer + drop the in-flight drain promise (next
 *     daemon boot picks the rows up again because they're still
 *     pending in SQLite).
 *
 * Failure handling:
 *   - Per-batch: a failed POST keeps rows in 'pending' but bumps
 *     `attempts` + records `last_error`. The next tick picks them up
 *     again. Rows whose attempt count crosses maxAttempts move to
 *     'archived' for forensic inspection (never deleted).
 *   - Inter-tick: exponential backoff on the POLL INTERVAL itself.
 *     After a failed tick the next tick delays 2^n * baseInterval
 *     (capped at maxInterval). Reset to base on the first success.
 *     Avoids the infinite-tight-loop the goal flags as a hazard.
 *
 * Durability guarantee: a redaction occurrence writes to SQLite FIRST
 * (in prompt-builder.ts via RedactionEmitStore.enqueue), THEN the
 * worker drains. Daemon crash between SQLite commit and POST → next
 * boot re-drains. Daemon crash between POST-200 and SQLite mark-sent
 * → next boot re-POSTs the same batch (tiny dup window — F1 finding).
 */

import type { DaemonSubsystem } from "../daemon/index.js";
import { getLogger } from "../utils/logger.js";
import { CLOUD_REDACTION_BATCH_CAP } from "./redaction-sink.js";
import type { RedactionSink } from "./redaction-sink.js";
import type { RedactionEmitStore } from "./redaction-emit-store.js";

const DEFAULT_BASE_INTERVAL_MS = 30_000; // 30s
const DEFAULT_MAX_INTERVAL_MS = 5 * 60_000; // 5 min
/**
 * Per-row attempt cap. At 30s base interval and exp-backoff, a row
 * stuck in retries hits this after ~hours. Past that, the cloud is
 * really unreachable and the row should be archived for review.
 */
const DEFAULT_MAX_ATTEMPTS = 100;

export interface RedactionEmitWorkerOptions {
  store: RedactionEmitStore;
  /** Null in local/offline mode — worker becomes a no-op. */
  sink: RedactionSink | null;
  /** Initial poll interval (defaults to 30s). */
  baseIntervalMs?: number;
  /** Backoff cap (defaults to 5min). */
  maxIntervalMs?: number;
  /** Per-row attempt cap before archive (defaults to 100). */
  maxAttempts?: number;
  /** Per-batch event cap. Defaults to the cloud's 1000. */
  batchSize?: number;
}

export class RedactionEmitWorker implements DaemonSubsystem {
  readonly name = "redaction-emit-worker";
  private readonly store: RedactionEmitStore;
  private readonly sink: RedactionSink | null;
  private readonly baseIntervalMs: number;
  private readonly maxIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  /** Current backoff interval. Reset to base on success, grows on failure. */
  private currentIntervalMs: number;
  private stopped = false;

  constructor(opts: RedactionEmitWorkerOptions) {
    this.store = opts.store;
    this.sink = opts.sink;
    this.baseIntervalMs = opts.baseIntervalMs ?? DEFAULT_BASE_INTERVAL_MS;
    this.maxIntervalMs = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.batchSize = Math.min(
      opts.batchSize ?? CLOUD_REDACTION_BATCH_CAP,
      CLOUD_REDACTION_BATCH_CAP,
    );
    this.currentIntervalMs = this.baseIntervalMs;
  }

  async start(): Promise<void> {
    const log = getLogger(this.name);
    if (!this.sink) {
      log.info(
        "redaction emit worker disabled (no sink configured — local/offline mode); " +
          "SQLite queue continues to capture rows for forensic inspection",
      );
      return;
    }
    log.info(
      {
        baseIntervalMs: this.baseIntervalMs,
        maxIntervalMs: this.maxIntervalMs,
        maxAttempts: this.maxAttempts,
        batchSize: this.batchSize,
        apiBaseUrl: this.sink.apiBaseUrl,
      },
      "redaction emit worker starting",
    );
    // Immediate first-tick drain (handles restart-resume on already-
    // pending rows). Scheduling chains itself via scheduleNext().
    this.inflight = this.tick();
    await this.inflight;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      try {
        await this.inflight;
      } catch {
        /* drain swallows its own errors; never throws */
      }
    }
  }

  /**
   * One drain pass. Pulls a batch, attempts POST, transitions rows,
   * adjusts backoff, schedules the next tick (when not stopped).
   *
   * Exposed for tests so they can step the worker without sleeping.
   */
  async tick(): Promise<void> {
    if (!this.sink) return;
    const log = getLogger(this.name);
    let succeeded = false;
    try {
      const pending = this.store.listPending(this.batchSize);
      if (pending.length === 0) {
        succeeded = true;
        return;
      }
      const eventIds = pending.map((r) => r.event_id);
      // cloud-PASS-028: surface event_id in the cloud payload so the
      // cloud-side ON CONFLICT (daemon_event_id) DO NOTHING gives end-
      // to-end at-most-once across daemon restarts (F1 resolved).
      const events = pending.map((r) => ({ event_id: r.event_id, ...r.payload }));
      const result = await this.sink.post(events);
      if (result.ok) {
        const transitioned = this.store.markSent(eventIds);
        log.info(
          {
            batchSize: pending.length,
            transitioned,
            inserted: result.inserted,
          },
          "redaction batch drained",
        );
        succeeded = true;
      } else {
        const errSummary = `status=${result.status ?? "network"} body=${result.errorBody.slice(0, 200)}`;
        this.store.markFailed(eventIds, errSummary);
        const archived = this.store.archiveExhausted(this.maxAttempts);
        if (archived.length > 0) {
          log.error(
            {
              archivedCount: archived.length,
              maxAttempts: this.maxAttempts,
              sampleIds: archived.slice(0, 3),
            },
            "redaction events archived after exhausting retries — review needed",
          );
        }
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "redaction worker tick failed unexpectedly",
      );
    } finally {
      if (succeeded) {
        this.currentIntervalMs = this.baseIntervalMs;
      } else {
        // Exponential backoff, capped. Doubles each consecutive failure.
        this.currentIntervalMs = Math.min(this.currentIntervalMs * 2, this.maxIntervalMs);
      }
      this.scheduleNext();
    }
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.inflight = this.tick();
    }, this.currentIntervalMs);
    // Don't keep the event loop alive on this timer alone — the daemon's
    // own run() loop holds the process up.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }
}
