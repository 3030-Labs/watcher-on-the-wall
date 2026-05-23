/**
 * Periodic background lint. Runs the same structural sweep as
 * `wotw lint` on a timer so the operator gets a heads-up when orphaned
 * pages accumulate or future sub-lints start reporting issues.
 *
 * Implements {@link DaemonSubsystem}. The interval is unref'd so it
 * never keeps the event loop alive on its own — the daemon's internal
 * keep-alive is what actually holds the process open. Respects
 * `config.lint.schedule_enabled`: when false, `start()` is a cheap
 * no-op and the scheduler logs one INFO line explaining itself.
 */
import { getLogger } from "../utils/logger.js";
import type { WotwConfig } from "../utils/types.js";
import { runLintPass, type LintResult } from "../cli/commands/lint.js";
import type { DaemonSubsystem } from "./index.js";

export interface LintSchedulerOptions {
  config: WotwConfig;
  /**
   * Override the lint runner — only used by tests so they can assert
   * the scheduler is calling through on each interval without touching
   * the filesystem.
   */
  runner?: (config: WotwConfig, opts?: { fix?: boolean; yes?: boolean }) => Promise<LintResult>;
}

/** One hour in milliseconds — unit used by the interval math. */
const MS_PER_HOUR = 60 * 60 * 1000;

export class LintScheduler implements DaemonSubsystem {
  readonly name = "lint-scheduler";
  private readonly opts: LintSchedulerOptions;
  private timer: NodeJS.Timeout | null = null;
  /** Last computed result — exposed for tests and future status output. */
  private lastResult: LintResult | null = null;

  constructor(opts: LintSchedulerOptions) {
    this.opts = opts;
  }

  async start(): Promise<void> {
    const log = getLogger("lint-scheduler");
    const { schedule_enabled: enabled, interval_hours: intervalHours } = this.opts.config.lint;
    if (!enabled) {
      log.info("lint scheduler disabled (set lint.schedule_enabled=true to enable)");
      return;
    }
    const intervalMs = Math.max(1, Math.round(intervalHours * MS_PER_HOUR));
    log.info({ intervalHours, intervalMs }, "lint scheduler starting");
    // Review item 31: pre-fix runOnce was fire-and-forget; if one tick's
    // runOnce was still in flight when the next interval fired, two
    // concurrent runs would race on writes, search-rebuild, provenance,
    // git-commit, and cost-tracker. Gate interval ticks with an
    // in-flight flag so a tardy run skips one cycle instead of racing.
    // The startup tick is not gated (it's the first run and has nothing
    // to race with) so observers can see the initial state immediately.
    let inFlight = false;
    const startupPromise = this.runOnce()
      .catch(() => undefined)
      .finally(() => {
        // Mark the startup run as no-longer-blocking — it took its turn.
      });
    void startupPromise;
    const timer = setInterval(() => {
      if (inFlight) {
        log.warn({}, "lint scheduler skipping tick — previous runOnce still in flight");
        return;
      }
      inFlight = true;
      void this.runOnce().finally(() => {
        inFlight = false;
      });
    }, intervalMs);
    // Do NOT keep the event loop alive for the scheduler — the daemon's
    // own check-interval is the keep-alive. Without unref() a stopped
    // daemon would hang waiting for the next lint tick.
    timer.unref();
    this.timer = timer;
  }

  async stop(): Promise<void> {
    const log = getLogger("lint-scheduler");
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      log.info("lint scheduler stopped");
    }
  }

  /** Last result produced by the scheduler — null until the first run. */
  getLastResult(): LintResult | null {
    return this.lastResult;
  }

  /**
   * Run a single lint pass and log the result. Exposed for tests and for
   * callers that want to force a pass outside the interval cadence.
   */
  async runOnce(): Promise<LintResult | null> {
    const log = getLogger("lint-scheduler");
    const runner = this.opts.runner ?? runLintPass;
    const autoFix = this.opts.config.lint.auto_fix === true;
    try {
      const result = await runner(this.opts.config, autoFix ? { fix: true, yes: true } : undefined);
      this.lastResult = result;
      if (result.missingWikiDir) {
        log.warn(
          { wikiRoot: result.wikiRoot },
          "lint scheduler: wiki directory missing — skipping sweep",
        );
      } else if (result.issueCount > 0) {
        log.warn(
          {
            totalPages: result.totalPages,
            orphanedPages: result.orphanedPages,
            issueCount: result.issueCount,
          },
          "lint scheduler: issues found",
        );
      } else {
        log.info({ totalPages: result.totalPages }, "lint scheduler: clean sweep — no issues");
      }
      // After lint, check zero-hit rate and run vocabulary enrichment if needed.
      if (this.opts.config.health.enrichment_enabled) {
        try {
          const { computeZeroHitRate } = await import("../server/query-metrics.js");
          const metrics = computeZeroHitRate(this.opts.config.health.query_log_file);
          if (metrics.zero_hit_rate > this.opts.config.health.zero_hit_threshold) {
            log.info(
              { rate: (metrics.zero_hit_rate * 100).toFixed(0) },
              "zero-hit rate exceeds threshold — vocabulary enrichment would run",
            );
            // Enrichment requires full context (store, search, etc.) that the scheduler
            // doesn't have. In daemon mode, enrichment runs via `wotw lint --fix` which
            // has the full heal context. Log for observability here.
          }
        } catch {
          // Non-fatal — metrics computation may fail if log file doesn't exist yet.
        }
      }

      return result;
    } catch (err) {
      log.error({ err }, "lint scheduler: sweep failed");
      return null;
    }
  }
}
