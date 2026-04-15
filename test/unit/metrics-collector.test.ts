import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MetricsCollector } from "../../src/hosted/metrics-collector.js";

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("MetricsCollector", () => {
  const wikiId = "wiki-123";
  const supabaseUrl = "https://test.supabase.co";
  const serviceKey = "test-service-key";
  let collector: MetricsCollector;

  beforeEach(() => {
    mockFetch.mockReset();
    collector = new MetricsCollector(wikiId, supabaseUrl, serviceKey);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recordIngestion PATCHes tenant_metrics with correct payload", async () => {
    // First call: read current metrics
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        daily_imports_today: 5,
        daily_ingest_bytes_today: 1000,
        total_pages: 10,
        avg_job_latency_ms: 200,
        total_queries: 3,
      }),
    });
    // Second call: patch
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordIngestion({
      pagesWritten: 2,
      bytesIngested: 500,
      durationMs: 300,
      success: true,
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Verify PATCH call
    const patchCall = mockFetch.mock.calls[1]!;
    expect(patchCall[0]).toContain("/rest/v1/tenant_metrics");
    expect(patchCall[1]?.method).toBe("PATCH");

    const body = JSON.parse(patchCall[1]?.body as string);
    expect(body.daily_imports_today).toBe(6);
    expect(body.daily_ingest_bytes_today).toBe(1500);
    expect(body.total_pages).toBe(12);
    expect(body.last_ingestion_at).toBeDefined();
  });

  it("recordQuery increments total_queries", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ total_queries: 7 }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordQuery({ durationMs: 50, hitCount: 3 });

    const patchCall = mockFetch.mock.calls[1]!;
    const body = JSON.parse(patchCall[1]?.body as string);
    expect(body.total_queries).toBe(8);
    expect(body.last_query_at).toBeDefined();
  });

  it("recordJobState writes queue depth and active jobs", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordJobState({ queueDepth: 5, activeJobs: 2 });

    const patchCall = mockFetch.mock.calls[0]!;
    const body = JSON.parse(patchCall[1]?.body as string);
    expect(body.queue_depth).toBe(5);
    expect(body.active_jobs).toBe(2);
  });

  it("recordFailure increments failed_jobs_24h", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ failed_jobs_24h: 3 }),
    });
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordFailure();

    const patchCall = mockFetch.mock.calls[1]!;
    const body = JSON.parse(patchCall[1]?.body as string);
    expect(body.failed_jobs_24h).toBe(4);
  });

  it("recordGuardrailHit POSTs to guardrail_hits table", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordGuardrailHit({
      guardrail: "storage_cap",
      currentValue: 2_100_000_000,
      limit: 2_147_483_648,
      detail: "over 2GB cap",
    });

    const postCall = mockFetch.mock.calls[0]!;
    expect(postCall[0]).toContain("/rest/v1/guardrail_hits");
    expect(postCall[1]?.method).toBe("POST");

    const body = JSON.parse(postCall[1]?.body as string);
    expect(body.wiki_id).toBe(wikiId);
    expect(body.guardrail).toBe("storage_cap");
    expect(body.current_value).toBe(2_100_000_000);
    expect(body.limit_value).toBe(2_147_483_648);
  });

  it("resetDailyCounters zeroes daily fields", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.resetDailyCounters();

    const patchCall = mockFetch.mock.calls[0]!;
    const body = JSON.parse(patchCall[1]?.body as string);
    expect(body.daily_imports_today).toBe(0);
    expect(body.daily_ingest_bytes_today).toBe(0);
    expect(body.failed_jobs_24h).toBe(0);
  });

  it("does not throw on fetch failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("network error"));

    // Should not throw
    await expect(
      collector.recordIngestion({
        pagesWritten: 1,
        bytesIngested: 100,
        durationMs: 50,
        success: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("sends correct auth headers", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    await collector.recordJobState({ queueDepth: 0, activeJobs: 0 });

    const headers = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers.apikey).toBe(serviceKey);
    expect(headers.Authorization).toBe(`Bearer ${serviceKey}`);
  });
});
