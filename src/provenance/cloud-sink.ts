/**
 * CloudProvenanceSink — fire-and-forget HTTP sink that mirrors each
 * provenance record append to wotw-cloud's Supabase replica.
 *
 * JSONL on disk is the canonical chain. This sink is a sync-replica so
 * the user-facing /provenance UI in wotw-cloud has real data. Sink
 * failures (network, wotw-cloud down, validation) log but never throw —
 * the JSONL append already succeeded, the cloud replica catches up on
 * the next successful append's chain-hash linkage check.
 *
 * Configuration via hosted-mode env vars (all required for the sink to
 * be active; if any is missing, the daemon constructs without a sink
 * and JSONL-only operation continues — allows local dev and
 * interactive mode):
 *
 *   WOTW_WIKI_ID          — UUID of the wiki this daemon serves
 *   WOTW_API_BASE_URL     — base URL of wotw-cloud (default https://wotw.dev)
 *   ADMIN_SERVICE_KEY     — shared secret for /api/internal/* admin endpoints
 *
 * The sink POSTs to `${WOTW_API_BASE_URL}/api/internal/append-provenance`
 * with `x-admin-key: ${ADMIN_SERVICE_KEY}` and a JSON body of
 * `{ wiki_id, seq, record_id, chain_hash, operation_type, source_files,
 *    wiki_files_written, model_id, timestamp, record_json }`.
 *
 * wotw-cloud's endpoint validates against the table's `unique (wiki_id,
 * seq)` constraint with ON CONFLICT DO NOTHING — so daemon retries
 * (network blip, restart mid-append) won't double-write.
 */
import type { ProvenanceRecord } from "../utils/types.js";
import { getLogger } from "../utils/logger.js";

const DEFAULT_API_BASE_URL = "https://wotw.dev";
const REQUEST_TIMEOUT_MS = 5_000;

export interface CloudSinkOptions {
  wikiId: string;
  apiBaseUrl?: string;
  adminServiceKey: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/**
 * The shape sent to wotw-cloud's /api/internal/append-provenance endpoint.
 * Mirrors the Supabase `provenance_records` table columns + the full
 * record under `record_json` for the verify-chain endpoint.
 */
export interface CloudSinkPayload {
  wiki_id: string;
  seq: number;
  record_id: string;
  chain_hash: string;
  operation_type: string;
  source_files: string[];
  wiki_files_written: string[];
  model_id: string | null;
  timestamp: string;
  record_json: ProvenanceRecord;
}

export class CloudProvenanceSink {
  readonly wikiId: string;
  readonly apiBaseUrl: string;
  private readonly adminServiceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudSinkOptions) {
    this.wikiId = opts.wikiId;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    this.adminServiceKey = opts.adminServiceKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * POST a single record to wotw-cloud. Returns a Promise that resolves
   * to true on success (HTTP 200 or 409-on-conflict) and false on
   * failure. NEVER throws — caller treats failure as logged-and-moved-on.
   */
  async append(record: ProvenanceRecord): Promise<boolean> {
    const log = getLogger("provenance.cloud-sink");
    const url = `${this.apiBaseUrl}/api/internal/append-provenance`;

    const payload: CloudSinkPayload = {
      wiki_id: this.wikiId,
      seq: record.seq,
      record_id: record.id,
      chain_hash: record.chain_hash,
      operation_type: record.type,
      source_files: record.source_files,
      wiki_files_written: record.wiki_files_written,
      model_id: record.model_id,
      timestamp: record.timestamp,
      record_json: record,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-admin-key": this.adminServiceKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      // 200 = inserted, 409 = idempotent conflict (already present). Both
      // are "the cloud knows about this record"; treat as success.
      if (res.ok || res.status === 409) {
        log.debug(
          {
            seq: record.seq,
            id: record.id.slice(0, 12),
            status: res.status,
          },
          "provenance record synced to cloud",
        );
        return true;
      }
      const body = await res.text().catch(() => "");
      log.warn(
        {
          seq: record.seq,
          id: record.id.slice(0, 12),
          status: res.status,
          body: body.slice(0, 500),
        },
        "cloud sink rejected provenance record",
      );
      return false;
    } catch (err) {
      log.warn(
        {
          seq: record.seq,
          id: record.id.slice(0, 12),
          err: err instanceof Error ? err.message : String(err),
        },
        "cloud sink request failed",
      );
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Construct a CloudProvenanceSink from env vars if all required vars
 * are present. Returns null if any required env var is missing (allows
 * local dev / interactive mode to operate JSONL-only without errors).
 */
export function cloudSinkFromEnv(env: NodeJS.ProcessEnv = process.env): CloudProvenanceSink | null {
  const wikiId = env.WOTW_WIKI_ID;
  const adminServiceKey = env.ADMIN_SERVICE_KEY;
  if (!wikiId || !adminServiceKey) {
    return null;
  }
  return new CloudProvenanceSink({
    wikiId,
    apiBaseUrl: env.WOTW_API_BASE_URL || undefined,
    adminServiceKey,
  });
}
