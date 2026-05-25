/**
 * Auto-archive cron for workspace DEKs past their rotation overlap
 * window (PASS-019 Part C).
 *
 * After `KeyStore.rotate()` transitions the previous active DEK to
 * `rotating`, the daemon needs to eventually transition it to
 * `archived` so it stops appearing in operator-facing
 * `state='rotating'` queries that suggest a rotation is still in
 * progress. This scheduler does it on a configurable interval —
 * default hourly tick, default 24-hour overlap window.
 *
 * Implements {@link DaemonSubsystem}. The interval is unref'd; the
 * daemon's own keepalive holds the process. Pattern mirrors
 * `LintScheduler` in this same directory.
 *
 * Operator override: `WOTW_DEK_OVERLAP_HOURS` env var. The same CLI
 * subcommand (`wotw workspace archive-overlapped`) can force-archive
 * outside the cron cadence.
 */
import { getLogger } from "../utils/logger.js";
import type { KeyStore } from "../keys/store.js";
import type { DaemonSubsystem } from "./index.js";

/** Default overlap window. Operators can override via WOTW_DEK_OVERLAP_HOURS. */
const DEFAULT_OVERLAP_HOURS = 24;
/** How often the cron ticks. Operators don't override this — tick cadence is independent of overlap window. */
const TICK_INTERVAL_HOURS = 1;
const MS_PER_HOUR = 60 * 60 * 1000;

export interface DekArchiveSchedulerOptions {
  keyStore: KeyStore;
  workspaceId: string;
  /**
   * Overlap window in hours. Records signed by a `rotating` DEK still
   * verify; the only effect of archiving is the lifecycle-state label.
   * Defaults to `WOTW_DEK_OVERLAP_HOURS` env or 24h.
   */
  overlapHours?: number;
  /**
   * Tick cadence in hours. Default 1h. Exposed for tests so they can
   * trigger ticks at a faster cadence without waiting for real time.
   */
  tickIntervalHours?: number;
  /**
   * Optional time-source override. Tests use `vi.useFakeTimers()` +
   * inject `() => new Date(Date.now()).toISOString()` to control the
   * reference clock without monkey-patching globals.
   */
  now?: () => string;
}

export class DekArchiveScheduler implements DaemonSubsystem {
  readonly name = "dek-archive-scheduler";
  private readonly opts: DekArchiveSchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  /** Last cron result, for tests + future status output. */
  private lastResult: { archived: number; archivedAt: string } | null = null;

  constructor(opts: DekArchiveSchedulerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const log = getLogger("dek-archive-scheduler");
    const overlapHours = this.resolveOverlapHours();
    const tickHours = this.opts.tickIntervalHours ?? TICK_INTERVAL_HOURS;
    const tickMs = Math.max(1, Math.round(tickHours * MS_PER_HOUR));
    log.info(
      { overlapHours, tickHours, workspaceId: this.opts.workspaceId },
      "DEK auto-archive scheduler starting",
    );
    // Run once at startup so any rotating DEKs left over from a previous
    // daemon process get a chance to archive immediately. Then on the
    // scheduled cadence.
    let inFlight = false;
    this.runOnce().catch(() => undefined);
    const timer = setInterval(() => {
      if (inFlight) {
        log.warn({}, "DEK auto-archive scheduler skipping tick — previous runOnce still in flight");
        return;
      }
      inFlight = true;
      this.runOnce().finally(() => {
        inFlight = false;
      });
    }, tickMs);
    timer.unref();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      getLogger("dek-archive-scheduler").info("DEK auto-archive scheduler stopped");
    }
  }

  /**
   * Run one archive sweep. Exposed for tests + the manual CLI trigger.
   * Returns the count of DEKs transitioned.
   */
  async runOnce(): Promise<number> {
    const log = getLogger("dek-archive-scheduler");
    const overlapHours = this.resolveOverlapHours();
    const overlapMs = overlapHours * MS_PER_HOUR;
    const now = this.opts.now ? this.opts.now() : new Date().toISOString();
    try {
      const archived = this.opts.keyStore.archiveOverlapped(this.opts.workspaceId, overlapMs, now);
      this.lastResult = { archived: archived.length, archivedAt: now };
      if (archived.length > 0) {
        log.info(
          {
            count: archived.length,
            overlapHours,
            workspaceId: this.opts.workspaceId,
          },
          "DEK auto-archive: rotating DEKs archived",
        );
      } else {
        log.debug({ overlapHours }, "DEK auto-archive: no rotating DEKs past overlap");
      }
      return archived.length;
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "DEK auto-archive sweep failed",
      );
      return 0;
    }
  }

  /** Last sweep result — null until the first tick. */
  getLastResult(): { archived: number; archivedAt: string } | null {
    return this.lastResult;
  }

  private resolveOverlapHours(): number {
    if (this.opts.overlapHours !== undefined && this.opts.overlapHours > 0) {
      return this.opts.overlapHours;
    }
    const envValue = process.env.WOTW_DEK_OVERLAP_HOURS;
    if (envValue) {
      const n = Number(envValue);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return DEFAULT_OVERLAP_HOURS;
  }
}
