/**
 * Query metrics — compute zero-hit rate and track query outcomes.
 *
 * The query log is an append-only JSONL file recording every query and
 * whether it returned zero results. Used for vocabulary enrichment triggers.
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";

export interface QueryLogEntry {
  timestamp: string;
  query: string;
  zero_hit: boolean;
  citations: number;
}

export interface ZeroHitMetrics {
  total_queries: number;
  zero_hits: number;
  zero_hit_rate: number;
  recent_zero_hit_queries: string[];
}

/**
 * Append a query outcome to the query log. Never throws — sink failures
 * are logged and swallowed to avoid breaking the query path.
 */
export function recordQueryOutcome(logFile: string, query: string, citationCount: number): void {
  if (!logFile) return;
  const log = getLogger("query-metrics");
  const entry: QueryLogEntry = {
    timestamp: new Date().toISOString(),
    query,
    zero_hit: citationCount === 0,
    citations: citationCount,
  };
  try {
    ensureDirSync(dirname(logFile));
    appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    log.warn({ err }, "failed to write query log entry");
  }
}

/**
 * Compute zero-hit rate from the query log within a time window.
 */
export function computeZeroHitRate(logFile: string, windowDays = 7): ZeroHitMetrics {
  const empty: ZeroHitMetrics = {
    total_queries: 0,
    zero_hits: 0,
    zero_hit_rate: 0,
    recent_zero_hit_queries: [],
  };

  if (!logFile || !existsSync(logFile)) return empty;

  let raw: string;
  try {
    raw = readFileSync(logFile, "utf8");
  } catch {
    return empty;
  }

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  let total = 0;
  let zeroHits = 0;
  const zeroHitQueries: string[] = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as QueryLogEntry;
      if (entry.timestamp < cutoff) continue;
      total++;
      if (entry.zero_hit) {
        zeroHits++;
        zeroHitQueries.push(entry.query);
      }
    } catch {
      // Skip malformed lines.
    }
  }

  return {
    total_queries: total,
    zero_hits: zeroHits,
    zero_hit_rate: total > 0 ? zeroHits / total : 0,
    recent_zero_hit_queries: zeroHitQueries,
  };
}
