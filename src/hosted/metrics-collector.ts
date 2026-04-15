/**
 * Collects and reports per-tenant metrics to the Supabase cloud database.
 * Only constructed when hosted.enabled is true. Uses raw HTTP fetch to
 * avoid importing the Supabase SDK — keeps the daemon decoupled.
 */
import { getLogger } from "../utils/logger.js";

export class MetricsCollector {
  private readonly tenantId: string;
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly log = getLogger("metrics-collector");

  constructor(
    private readonly wikiId: string,
    supabaseUrl: string,
    serviceKey: string,
  ) {
    this.tenantId = wikiId;
    this.baseUrl = `${supabaseUrl}/rest/v1`;
    this.headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    };
  }

  async recordIngestion(opts: {
    pagesWritten: number;
    bytesIngested: number;
    durationMs: number;
    success: boolean;
  }): Promise<void> {
    try {
      // Read current metrics to compute rolling avg
      const current = await this.readMetrics();
      const prevAvg = current?.avg_job_latency_ms ?? 0;
      const prevCount = (current?.daily_imports_today ?? 0) + (current?.total_queries ?? 0);
      const newAvg =
        prevCount > 0
          ? Math.round((prevAvg * prevCount + opts.durationMs) / (prevCount + 1))
          : opts.durationMs;

      await this.patchMetrics({
        daily_imports_today: (current?.daily_imports_today ?? 0) + 1,
        daily_ingest_bytes_today: (current?.daily_ingest_bytes_today ?? 0) + opts.bytesIngested,
        total_pages: (current?.total_pages ?? 0) + opts.pagesWritten,
        last_ingestion_at: new Date().toISOString(),
        avg_job_latency_ms: newAvg,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to record ingestion metrics");
    }
  }

  async recordQuery(_opts: { durationMs: number; hitCount: number }): Promise<void> {
    try {
      const current = await this.readMetrics();
      await this.patchMetrics({
        total_queries: (current?.total_queries ?? 0) + 1,
        last_query_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to record query metrics");
    }
  }

  async recordJobState(opts: { queueDepth: number; activeJobs: number }): Promise<void> {
    try {
      await this.patchMetrics({
        queue_depth: opts.queueDepth,
        active_jobs: opts.activeJobs,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to record job state");
    }
  }

  async recordFailure(): Promise<void> {
    try {
      const current = await this.readMetrics();
      await this.patchMetrics({
        failed_jobs_24h: (current?.failed_jobs_24h ?? 0) + 1,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to record failure metric");
    }
  }

  async recordGuardrailHit(opts: {
    guardrail: string;
    currentValue: number;
    limit: number;
    detail?: string;
  }): Promise<void> {
    this.log.warn(
      {
        tenantId: this.tenantId,
        guardrail: opts.guardrail,
        currentValue: opts.currentValue,
        limit: opts.limit,
        detail: opts.detail,
      },
      `guardrail hit: ${opts.guardrail}`,
    );

    try {
      const res = await fetch(`${this.baseUrl}/guardrail_hits`, {
        method: "POST",
        headers: this.headers,
        body: JSON.stringify({
          wiki_id: this.wikiId,
          guardrail: opts.guardrail,
          current_value: opts.currentValue,
          limit_value: opts.limit,
          detail: opts.detail ?? null,
        }),
      });
      if (!res.ok) {
        this.log.warn(
          { status: res.status, tenantId: this.tenantId },
          "failed to insert guardrail hit",
        );
      }
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to record guardrail hit");
    }
  }

  async resetDailyCounters(): Promise<void> {
    try {
      await this.patchMetrics({
        daily_imports_today: 0,
        daily_ingest_bytes_today: 0,
        daily_reset_date: new Date().toISOString().slice(0, 10),
        failed_jobs_24h: 0,
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      this.log.warn({ err, tenantId: this.tenantId }, "failed to reset daily counters");
    }
  }

  // ---- internal helpers ----

  private async readMetrics(): Promise<Record<string, number> | null> {
    const res = await fetch(`${this.baseUrl}/tenant_metrics?wiki_id=eq.${this.wikiId}&select=*`, {
      headers: { ...this.headers, Accept: "application/vnd.pgrst.object+json" },
    });
    if (!res.ok) return null;
    return res.json() as Promise<Record<string, number>>;
  }

  private async patchMetrics(data: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.baseUrl}/tenant_metrics?wiki_id=eq.${this.wikiId}`, {
      method: "PATCH",
      headers: this.headers,
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      this.log.warn(
        { status: res.status, tenantId: this.tenantId },
        "failed to patch tenant_metrics",
      );
    }
  }
}
