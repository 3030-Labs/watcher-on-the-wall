/**
 * Multi-tenant job scheduler with round-robin fairness, per-tenant
 * concurrency caps, and a kill switch. Only active when `hosted.enabled`
 * is true — the single-user p-queue path is unchanged.
 */
import { getLogger } from "../utils/logger.js";

export interface TenantJob {
  tenantId: string;
  batchId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers return heterogeneous result types
  execute: () => Promise<any>;
}

export class TenantScheduler {
  private readonly globalConcurrency: number;
  private readonly getConcurrencyCap: (tenantId: string) => number;
  private readonly isPaused: (tenantId: string) => boolean;

  /** Per-tenant FIFO job queues. */
  private readonly subqueues = new Map<string, TenantJob[]>();
  /** Ordered list of tenant IDs for round-robin iteration. */
  private tenantOrder: string[] = [];
  /** Index into tenantOrder for round-robin fairness. */
  private rrIndex = 0;

  /** Number of jobs currently executing per tenant. */
  private readonly activeByTenant = new Map<string, number>();
  /** Total jobs currently executing across all tenants. */
  private globalActive = 0;

  /** Set to true when stop() is called — no new jobs accepted. */
  private stopped = false;
  /** Resolvers waiting for drain(). */
  private drainResolvers: Array<() => void> = [];
  /** Currently scheduled processing tick (prevents duplicate scheduling). */
  private tickScheduled = false;

  constructor(opts: {
    globalConcurrency: number;
    getConcurrencyCap: (tenantId: string) => number;
    isPaused: (tenantId: string) => boolean;
  }) {
    this.globalConcurrency = opts.globalConcurrency;
    this.getConcurrencyCap = opts.getConcurrencyCap;
    this.isPaused = opts.isPaused;
  }

  /**
   * Enqueue a job. It will be scheduled when capacity is available and the
   * tenant is not paused.
   */
  enqueue(job: TenantJob): void {
    if (this.stopped) {
      const log = getLogger("tenant-scheduler");
      log.warn(
        { tenantId: job.tenantId, batchId: job.batchId },
        "scheduler stopped — rejecting job",
      );
      return;
    }
    if (!this.subqueues.has(job.tenantId)) {
      this.subqueues.set(job.tenantId, []);
      this.tenantOrder.push(job.tenantId);
    }
    this.subqueues.get(job.tenantId)!.push(job);
    this.scheduleTick();
  }

  /** Number of pending (not yet executing) jobs for a tenant. */
  getQueueDepth(tenantId: string): number {
    return this.subqueues.get(tenantId)?.length ?? 0;
  }

  /** Total pending jobs across all tenants. */
  getTotalQueueDepth(): number {
    let total = 0;
    for (const q of this.subqueues.values()) total += q.length;
    return total;
  }

  /** Number of currently executing jobs for a tenant. */
  getActiveJobs(tenantId: string): number {
    return this.activeByTenant.get(tenantId) ?? 0;
  }

  /** Total active jobs across all tenants. */
  getTotalActiveJobs(): number {
    return this.globalActive;
  }

  /** Wait for all in-flight jobs to complete. */
  async drain(): Promise<void> {
    if (this.globalActive === 0 && this.getTotalQueueDepth() === 0) return;
    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve);
    });
  }

  /** Stop accepting new jobs. In-flight jobs are allowed to complete. */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Toggle the paused state for a tenant at runtime. Paused tenants' jobs
   * stay in the queue (not dropped). Unpausing triggers a processing tick.
   */
  setPaused(tenantId: string, paused: boolean): void {
    // The paused state is delegated to the callback — this method exists
    // so the caller can trigger re-evaluation after changing the state.
    // We intentionally don't store paused state here; the isPaused callback
    // is the single source of truth. Log the intent and reschedule.
    const log = getLogger("tenant-scheduler");
    log.info({ tenantId, paused }, paused ? "tenant paused" : "tenant unpaused");
    if (!paused) {
      this.scheduleTick();
    }
  }

  /** Per-tenant timestamps of last completed job. */
  private readonly lastCompletedAt = new Map<string, Date>();
  /** Per-tenant rolling latency accumulators. */
  private readonly latencySum = new Map<string, number>();
  private readonly latencyCount = new Map<string, number>();

  /**
   * Returns a snapshot of queue state across all tenants.
   */
  getStatus(): {
    tenants: Array<{
      tenantId: string;
      queueDepth: number;
      activeJobs: number;
      paused: boolean;
      lastCompletedAt: Date | null;
      avgLatencyMs: number | null;
    }>;
    globalActiveJobs: number;
    globalQueueDepth: number;
  } {
    const tenants = this.tenantOrder.map((tenantId) => {
      const sum = this.latencySum.get(tenantId) ?? 0;
      const count = this.latencyCount.get(tenantId) ?? 0;
      return {
        tenantId,
        queueDepth: this.getQueueDepth(tenantId),
        activeJobs: this.getActiveJobs(tenantId),
        paused: this.isPaused(tenantId),
        lastCompletedAt: this.lastCompletedAt.get(tenantId) ?? null,
        avgLatencyMs: count > 0 ? Math.round(sum / count) : null,
      };
    });
    return {
      tenants,
      globalActiveJobs: this.globalActive,
      globalQueueDepth: this.getTotalQueueDepth(),
    };
  }

  // ---------------------------------------------------------------------------
  // Internal scheduling
  // ---------------------------------------------------------------------------

  private scheduleTick(): void {
    if (this.tickScheduled) return;
    this.tickScheduled = true;
    // Use queueMicrotask for immediate scheduling without setTimeout(0) delay
    queueMicrotask(() => {
      this.tickScheduled = false;
      this.processTick();
    });
  }

  /**
   * Round-robin processing loop. Iterates through tenants starting from
   * rrIndex so no tenant is systematically starved.
   */
  private processTick(): void {
    if (this.tenantOrder.length === 0) return;

    let launched = false;
    const n = this.tenantOrder.length;

    for (let i = 0; i < n; i++) {
      if (this.globalActive >= this.globalConcurrency) break;

      const idx = (this.rrIndex + i) % n;
      const tenantId = this.tenantOrder[idx]!;

      if (this.isPaused(tenantId)) continue;

      const queue = this.subqueues.get(tenantId);
      if (!queue || queue.length === 0) continue;

      const tenantActive = this.activeByTenant.get(tenantId) ?? 0;
      const cap = this.getConcurrencyCap(tenantId);
      if (tenantActive >= cap) continue;

      // Dequeue and execute
      const job = queue.shift()!;
      this.activeByTenant.set(tenantId, tenantActive + 1);
      this.globalActive++;
      launched = true;

      this.executeJob(job);
    }

    // Advance round-robin pointer so the next tick starts with a different tenant
    if (launched) {
      this.rrIndex = (this.rrIndex + 1) % n;
    }

    // Clean up empty tenant entries
    this.cleanupEmptyTenants();

    // Check if drained
    this.checkDrained();
  }

  private executeJob(job: TenantJob): void {
    const log = getLogger("tenant-scheduler");
    const startMs = Date.now();
    job
      .execute()
      .catch((err: unknown) => {
        log.error({ err, tenantId: job.tenantId, batchId: job.batchId }, "tenant job failed");
      })
      .finally(() => {
        const prev = this.activeByTenant.get(job.tenantId) ?? 1;
        this.activeByTenant.set(job.tenantId, prev - 1);
        this.globalActive--;

        // Track completion time and latency
        this.lastCompletedAt.set(job.tenantId, new Date());
        const elapsed = Date.now() - startMs;
        this.latencySum.set(job.tenantId, (this.latencySum.get(job.tenantId) ?? 0) + elapsed);
        this.latencyCount.set(job.tenantId, (this.latencyCount.get(job.tenantId) ?? 0) + 1);

        this.scheduleTick();
      });
  }

  private cleanupEmptyTenants(): void {
    this.tenantOrder = this.tenantOrder.filter((tid) => {
      const queue = this.subqueues.get(tid);
      const active = this.activeByTenant.get(tid) ?? 0;
      if ((!queue || queue.length === 0) && active === 0) {
        this.subqueues.delete(tid);
        this.activeByTenant.delete(tid);
        return false;
      }
      return true;
    });
    // Keep rrIndex in bounds
    if (this.tenantOrder.length > 0) {
      this.rrIndex = this.rrIndex % this.tenantOrder.length;
    } else {
      this.rrIndex = 0;
    }
  }

  private checkDrained(): void {
    if (
      this.globalActive === 0 &&
      this.getTotalQueueDepth() === 0 &&
      this.drainResolvers.length > 0
    ) {
      for (const resolve of this.drainResolvers) resolve();
      this.drainResolvers = [];
    }
  }
}
