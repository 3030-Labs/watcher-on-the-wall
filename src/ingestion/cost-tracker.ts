/**
 * Append-only cost log. One JSON object per line, persisted under the
 * configured `cost.track_file` path. Designed for fast append + cheap
 * tail reads (status command reads the last ~1000 lines).
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import type { CostLogEntry, ModelId, OperationType } from "../utils/types.js";

/** Return today's UTC date as `YYYY-MM-DD`. */
function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Shared JSONL cost-file parser. Sums `cost_usd` across every record whose
 * timestamp falls on the given UTC day. Used by both {@link CostTracker}
 * (for in-daemon budget checks) and by `wotw status` (for the "cost today"
 * readout) so there is a single source of truth for cost accounting
 * (L-CODE-3).
 *
 * Missing files, unreadable files, and malformed lines all return / skip
 * gracefully — the cost log is best-effort ledger, not a critical path.
 */
export function sumCostsForDay(trackFile: string, day: string = utcToday()): number {
  if (!existsSync(trackFile)) return 0;
  let text: string;
  try {
    text = readFileSync(trackFile, "utf8");
  } catch {
    return 0;
  }
  let total = 0;
  for (const rawLine of text.split("\n")) {
    if (!rawLine.trim()) continue;
    try {
      const entry = JSON.parse(rawLine) as { timestamp?: string; cost_usd?: number };
      if (
        typeof entry.timestamp === "string" &&
        entry.timestamp.slice(0, 10) === day &&
        typeof entry.cost_usd === "number"
      ) {
        total += entry.cost_usd;
      }
    } catch {
      // malformed line — skip
    }
  }
  return total;
}

export class CostTracker {
  private readonly trackFile: string;
  private readonly maxDailyUsd: number;
  private readonly maxPerIngestUsd: number;
  private readonly maxPerQueryUsd: number;
  /**
   * Cache of today's total spend (L-PERF-1). Before this cache, every
   * `wouldExceedDaily()` call re-scanned the entire JSONL cost log —
   * O(n) on every pre-flight budget check, which a long-running daemon
   * eventually feels. We lazily hydrate the cache on first read and
   * keep it in sync by incrementing on each `record()`. When the UTC
   * day rolls over we simply re-scan once (bounded by "lines written
   * today" which is small).
   */
  private cachedDay: string | null = null;
  private cachedTotal = 0;

  constructor(opts: {
    trackFile: string;
    maxDailyUsd: number;
    maxPerIngestUsd: number;
    maxPerQueryUsd: number;
  }) {
    this.trackFile = opts.trackFile;
    this.maxDailyUsd = opts.maxDailyUsd;
    this.maxPerIngestUsd = opts.maxPerIngestUsd;
    this.maxPerQueryUsd = opts.maxPerQueryUsd;
    ensureDirSync(dirname(this.trackFile));
  }

  /** Append a cost entry to the log. */
  record(entry: CostLogEntry): void {
    const line = `${JSON.stringify(entry)}\n`;
    try {
      appendFileSync(this.trackFile, line, "utf8");
    } catch (err) {
      getLogger("cost").error({ err, file: this.trackFile }, "failed to append cost entry");
      return;
    }
    // Keep the cache in sync without a re-scan. If the entry is for a
    // different UTC day than the cached one, drop the cache — the next
    // read will re-hydrate.
    const entryDay = entry.timestamp.slice(0, 10);
    const today = utcToday();
    if (entryDay === today) {
      if (this.cachedDay === today) {
        this.cachedTotal += entry.cost_usd;
      } else {
        // Not yet hydrated; let the next spentToday() re-scan.
        this.cachedDay = null;
      }
    } else if (entryDay !== this.cachedDay) {
      // Entry is for an older day (unusual — timestamps are always "now")
      // or for the future. Invalidate so we re-scan next read.
      this.cachedDay = null;
    }
  }

  /**
   * Sum cost entries whose timestamp falls within today (UTC). Backed by
   * the in-memory cache populated on the first call and kept warm by
   * {@link record}. On a UTC day rollover the cache is re-hydrated once.
   */
  spentToday(): number {
    const today = utcToday();
    if (this.cachedDay === today) return this.cachedTotal;
    const total = sumCostsForDay(this.trackFile, today);
    this.cachedDay = today;
    this.cachedTotal = total;
    return total;
  }

  /** Return true if the given cost would exceed today's daily budget. */
  wouldExceedDaily(next: number): boolean {
    return this.spentToday() + next > this.maxDailyUsd;
  }

  /** Check per-operation caps. Returns null if allowed, error string if not. */
  checkOperationBudget(op: OperationType, cost: number): string | null {
    if (op === "ingest" && cost > this.maxPerIngestUsd) {
      return `ingest cost $${cost.toFixed(4)} exceeds per-ingest cap $${this.maxPerIngestUsd}`;
    }
    if (op === "query" && cost > this.maxPerQueryUsd) {
      return `query cost $${cost.toFixed(4)} exceeds per-query cap $${this.maxPerQueryUsd}`;
    }
    if (this.wouldExceedDaily(cost)) {
      return `operation would exceed daily cap $${this.maxDailyUsd}`;
    }
    return null;
  }

  /** Log entry with `operation: type` convenience. */
  logUsage(params: {
    operation: OperationType;
    model: ModelId;
    costUsd: number;
    inputTokens?: number;
    outputTokens?: number;
    batchId?: string;
  }): void {
    this.record({
      timestamp: new Date().toISOString(),
      operation: params.operation,
      model_id: params.model,
      cost_usd: params.costUsd,
      input_tokens: params.inputTokens,
      output_tokens: params.outputTokens,
      batch_id: params.batchId,
    });
  }
}
