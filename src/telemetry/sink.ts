/**
 * Telemetry sink implementations.
 *
 * Privacy posture (PASS-023):
 *  - **Disabled by default.** `getTelemetrySink()` returns a no-op
 *    `NoopSink` unless `WOTW_TELEMETRY_DSN` is set in the environment.
 *  - **No embedded DSN.** The daemon ships zero Sentry credentials.
 *    Operators who want crash visibility provide their own Sentry
 *    project DSN — they own the data, not 3030 Labs.
 *  - **Categorical events only.** Even when active, the sink rejects
 *    payloads that contain anything other than the stable enum
 *    fields defined in {@link TelemetryFailureEvent}. No vault paths,
 *    no API keys, no user-controlled strings.
 *  - **Init failures only.** v1 sinks do not record successful
 *    operations, runtime telemetry, or query patterns. Init-time
 *    failures are the only emission surface.
 *
 * See [`docs/telemetry.md`](../../docs/telemetry.md) for the user-facing
 * opt-in instructions and privacy guarantees.
 */
import { getLogger } from "../utils/logger.js";
import type { TelemetryFailureCategory, TelemetryFailureEvent, TelemetrySink } from "./types.js";

const ALLOWED_CATEGORIES: readonly TelemetryFailureCategory[] = [
  "init/missing-vault-path",
  "init/target-not-empty",
  "init/config-parse-error",
  "init/native-binding-load-failure",
  "init/wiki-dir-permission-denied",
  "init/port-in-use",
  "init/daemon-already-running",
  "init/runtime-not-detected",
  "init/scaffold-failed",
  "init/unknown-failure",
];

const ALLOWED_FIELDS = new Set([
  "category",
  "daemonVersion",
  "platform",
  "arch",
  "nodeVersion",
  "stage",
]);

/**
 * Strict validator. Rejects any payload that does not match the
 * stable {@link TelemetryFailureEvent} shape. Returns `null` on
 * success, an error string on failure.
 */
export function validateEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null) {
    return "event must be an object";
  }
  const obj = event as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return `disallowed field on telemetry event: ${key}`;
    }
  }
  if (typeof obj.category !== "string") {
    return "category must be a string";
  }
  if (!ALLOWED_CATEGORIES.includes(obj.category as TelemetryFailureCategory)) {
    return `category not in allow-list: ${obj.category}`;
  }
  if (typeof obj.daemonVersion !== "string" || obj.daemonVersion.length === 0) {
    return "daemonVersion must be a non-empty string";
  }
  if (typeof obj.platform !== "string") return "platform must be a string";
  if (typeof obj.arch !== "string") return "arch must be a string";
  if (typeof obj.nodeVersion !== "string") {
    return "nodeVersion must be a string";
  }
  if (obj.stage !== undefined && typeof obj.stage !== "string") {
    return "stage must be a string when present";
  }
  return null;
}

/**
 * No-op sink. The default when telemetry is disabled. Calls are
 * silently discarded; nothing leaves the process.
 */
export class NoopSink implements TelemetrySink {
  recordInitFailure(_event: TelemetryFailureEvent): void {
    // intentionally empty
  }
}

/**
 * In-memory sink used by tests + opt-in debug mode. Records events
 * to an array readable via {@link recorded}. Validates every event
 * against {@link validateEvent} — a violation throws.
 */
export class MemorySink implements TelemetrySink {
  private events: TelemetryFailureEvent[] = [];

  recordInitFailure(event: TelemetryFailureEvent): void {
    const err = validateEvent(event);
    if (err !== null) {
      throw new Error(`MemorySink validation rejected event: ${err}`);
    }
    this.events.push({ ...event });
  }

  recorded(): readonly TelemetryFailureEvent[] {
    return this.events.slice();
  }

  clear(): void {
    this.events.length = 0;
  }
}

/**
 * Sentry-backed sink. Lazy-loads the Sentry SDK on first use so the
 * daemon's hot path doesn't pay for the import in the (vastly more
 * common) telemetry-disabled case.
 *
 * The DSN comes from `WOTW_TELEMETRY_DSN` (passed in via constructor).
 * Errors during Sentry send are swallowed — telemetry must never
 * cause an additional user-visible failure.
 */
export class SentrySink implements TelemetrySink {
  private readonly dsn: string;
  private initialized = false;

  constructor(dsn: string) {
    this.dsn = dsn;
  }

  recordInitFailure(event: TelemetryFailureEvent): void {
    const err = validateEvent(event);
    if (err !== null) {
      const log = getLogger("telemetry");
      log.warn({ err }, "telemetry event failed validation; dropping");
      return;
    }
    void this.send(event);
  }

  private async send(event: TelemetryFailureEvent): Promise<void> {
    const log = getLogger("telemetry");
    try {
      if (!this.initialized) {
        // Dynamic import so the Sentry SDK is only loaded when telemetry
        // is actually opted-in.
        const Sentry = await loadSentry();
        if (Sentry === null) {
          log.warn(
            "WOTW_TELEMETRY_DSN is set but @sentry/node is not installed; falling back to no-op",
          );
          return;
        }
        Sentry.init({
          dsn: this.dsn,
          // No automatic instrumentation — we want exactly one event type.
          defaultIntegrations: false,
          tracesSampleRate: 0,
          beforeSend(evt) {
            // Strip any auto-populated user data the SDK may inject.
            delete evt.user;
            delete evt.request;
            delete evt.contexts;
            return evt;
          },
        });
        this.initialized = true;
      }
      const Sentry = await loadSentry();
      if (Sentry === null) return;
      Sentry.captureEvent({
        message: `wotw init failure: ${event.category}`,
        level: "error",
        tags: {
          category: event.category,
          daemon_version: event.daemonVersion,
          platform: event.platform,
          arch: event.arch,
          node_version: event.nodeVersion,
          stage: event.stage ?? "(none)",
        },
      });
      await Sentry.flush(2000);
    } catch (sendErr) {
      // Telemetry MUST be best-effort.
      log.debug({ sendErr }, "telemetry send failed (suppressed)");
    }
  }
}

interface SentryShim {
  init(opts: {
    dsn: string;
    defaultIntegrations: false;
    tracesSampleRate: number;
    beforeSend(evt: { user?: unknown; request?: unknown; contexts?: unknown }): unknown;
  }): void;
  captureEvent(evt: { message: string; level: string; tags: Record<string, string> }): void;
  flush(timeoutMs: number): Promise<boolean>;
}

async function loadSentry(): Promise<SentryShim | null> {
  try {
    // @sentry/node is an OPTIONAL peer dependency. The default install of
    // @3030-labs/wotw does NOT pull it in — users who opt in to
    // telemetry install it explicitly (`npm install @sentry/node`).
    // Use a dynamic specifier so TypeScript doesn't require its types
    // to be present at typecheck time.
    const specifier = "@sentry/node";
    const mod = (await import(/* webpackIgnore: true */ specifier)) as {
      default?: SentryShim;
    } & SentryShim;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

/**
 * Factory: choose a sink based on the active environment. Defaults
 * to {@link NoopSink} unless `WOTW_TELEMETRY_DSN` is set.
 */
export function getTelemetrySink(env: NodeJS.ProcessEnv = process.env): TelemetrySink {
  const dsn = env.WOTW_TELEMETRY_DSN;
  if (dsn === undefined || dsn.trim().length === 0) {
    return new NoopSink();
  }
  return new SentrySink(dsn.trim());
}
