/**
 * RedactionSink — POST client for wotw-cloud's
 * `/api/internal/redaction-log` endpoint (PASS-024 / CT3).
 *
 * Pairs with `cloud-sink.ts` (which targets the provenance-replica
 * endpoint with `x-admin-key`) but is *distinct*: the redaction sink
 * uses the split-secret `x-sink-key` header against the
 * `WOTW_CLOUD_SINK_SECRET` env var (see split-secret rationale at
 * wotw-cloud `web/lib/admin-auth.ts:40-51`). A leak of the cloud-sink
 * key must NOT grant access to the broader /api/cron/* or /api/admin/*
 * surface.
 *
 * Behavior is fire-and-retry, not fire-and-forget: the caller
 * (RedactionEmitWorker) drives retries from the SQLite queue. This
 * class never throws — it returns a structured outcome the worker
 * uses to decide markSent / markFailed.
 *
 * Batch shape (PASS-024 contract + cloud-PASS-028 daemon_event_id
 * idempotency extension; cloud cap is 1000 events per call):
 *
 *   POST /api/internal/redaction-log
 *   x-sink-key: <WOTW_CLOUD_SINK_SECRET>
 *   Content-Type: application/json
 *   { workspace_id: <uuid>,
 *     events: [
 *       { event_id, redacted_at, rule_id, source_file_path,
 *         redaction_byte_count }
 *     ] }
 *
 * `event_id` is the daemon-side SQLite primary key (UUIDv4) carried
 * forward into the cloud payload. cloud-PASS-028 added a nullable
 * `daemon_event_id uuid` column on `redaction_log` with a partial
 * unique index + `ON CONFLICT (daemon_event_id) DO NOTHING` in the
 * route handler, so a restart-mid-batch re-POST is a no-op cloud-side.
 * The cloud returns 200 on conflict, mirroring its 409-treated-as-200
 * pattern from `cloud-sink.ts` — daemon treats the success as
 * authoritative and marks rows sent.
 */

import { getLogger } from "../utils/logger.js";
import type { RedactionEventPayload } from "./redaction-emit-store.js";

const DEFAULT_API_BASE_URL = "https://wotw.dev";
const REQUEST_TIMEOUT_MS = 10_000;
/** Cloud-side hard cap per PASS-024 route. */
export const CLOUD_REDACTION_BATCH_CAP = 1000;

/**
 * One cloud-bound event = the daemon-side payload augmented with the
 * `event_id` PRIMARY KEY. The cloud's `daemon_event_id` column +
 * partial unique index (cloud-PASS-028) deduplicates on this value,
 * giving end-to-end at-most-once delivery semantics across daemon
 * restarts.
 */
export interface RedactionSinkEvent extends RedactionEventPayload {
  event_id: string;
}

export interface RedactionSinkOptions {
  workspaceId: string;
  apiBaseUrl?: string;
  /** WOTW_CLOUD_SINK_SECRET value used as the x-sink-key header. */
  sinkSecret: string;
  /** Override for tests. */
  fetchImpl?: typeof fetch;
}

/** Outcome of one POST attempt. */
export type RedactionSinkResult =
  | { ok: true; inserted: number }
  | { ok: false; status: number | null; errorBody: string };

export class RedactionSink {
  readonly workspaceId: string;
  readonly apiBaseUrl: string;
  private readonly sinkSecret: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: RedactionSinkOptions) {
    this.workspaceId = opts.workspaceId;
    this.apiBaseUrl = opts.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    // Same fail-closed posture as cloud-sink.ts:74 — refuse to send the
    // sink secret over plaintext HTTP. A misconfigured WOTW_API_BASE_URL
    // would otherwise exfil the credential on first POST.
    if (!this.apiBaseUrl.startsWith("https://")) {
      throw new Error(
        `redaction-sink: apiBaseUrl must be https:// (got "${this.apiBaseUrl}"); ` +
          `WOTW_API_BASE_URL is misconfigured. Refusing to send sink key over plaintext.`,
      );
    }
    this.sinkSecret = opts.sinkSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /**
   * POST a single batch of redaction events to the cloud. Never throws;
   * caller decides whether to retry based on the returned `ok` field.
   *
   * The batch MUST contain at least one event and at most
   * CLOUD_REDACTION_BATCH_CAP events — the caller (worker) trims to fit.
   */
  async post(events: readonly RedactionSinkEvent[]): Promise<RedactionSinkResult> {
    const log = getLogger("provenance.redaction-sink");
    if (events.length === 0) {
      // Defensive: an empty batch would 400 cloud-side. Treat as no-op success.
      return { ok: true, inserted: 0 };
    }
    if (events.length > CLOUD_REDACTION_BATCH_CAP) {
      return {
        ok: false,
        status: null,
        errorBody: `client-side batch cap exceeded (got ${events.length}, max ${CLOUD_REDACTION_BATCH_CAP})`,
      };
    }
    const url = `${this.apiBaseUrl}/api/internal/redaction-log`;
    const body = {
      workspace_id: this.workspaceId,
      events: events.map((e) => ({
        event_id: e.event_id,
        redacted_at: e.redacted_at,
        rule_id: e.rule_id,
        source_file_path: e.source_file_path,
        redaction_byte_count: e.redaction_byte_count,
      })),
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-sink-key": this.sinkSecret,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) {
        let inserted = events.length;
        try {
          const data = (await res.json()) as { inserted?: number };
          if (typeof data.inserted === "number") inserted = data.inserted;
        } catch {
          // Cloud returned 200 with a non-JSON body. Trust the count we sent.
        }
        log.debug(
          {
            workspaceId: this.workspaceId,
            batchSize: events.length,
            inserted,
          },
          "redaction batch accepted by cloud",
        );
        return { ok: true, inserted };
      }
      const text = await res.text().catch(() => "");
      log.warn(
        {
          workspaceId: this.workspaceId,
          batchSize: events.length,
          status: res.status,
          body: text.slice(0, 500),
        },
        "redaction batch rejected by cloud",
      );
      return { ok: false, status: res.status, errorBody: text.slice(0, 500) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        {
          workspaceId: this.workspaceId,
          batchSize: events.length,
          err: msg,
        },
        "redaction batch request failed",
      );
      return { ok: false, status: null, errorBody: msg };
    } finally {
      clearTimeout(timeout);
    }
  }
}

/**
 * Construct a RedactionSink from env vars. Returns null when any of:
 *   - WOTW_WIKI_ID missing (no workspace to attribute events to)
 *   - WOTW_CLOUD_SINK_SECRET missing (no credential to authenticate)
 *
 * Local/offline operation is intentional: the SQLite queue still
 * captures rows for forensic inspection; only emission is disabled.
 * In hosted mode, the secret-missing case is gated upstream by
 * `validateHostedRedactionSink` in `src/daemon/config.ts` (fail-loud
 * before this point would be reached).
 */
export function redactionSinkFromEnv(env: NodeJS.ProcessEnv = process.env): RedactionSink | null {
  const wikiId = env.WOTW_WIKI_ID;
  const sinkSecret = env.WOTW_CLOUD_SINK_SECRET;
  if (!wikiId || !sinkSecret) return null;
  return new RedactionSink({
    workspaceId: wikiId,
    apiBaseUrl: env.WOTW_API_BASE_URL || undefined,
    sinkSecret,
  });
}
