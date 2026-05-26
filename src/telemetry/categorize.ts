/**
 * Map an ActionableError code (or arbitrary error) to a stable
 * TelemetryFailureCategory. The mapping is deterministic and
 * exhaustive — every ActionableError code in the v0.8.4 surface
 * has a corresponding category. Unknown errors map to
 * `init/unknown-failure`.
 */
import { arch, platform } from "node:os";
import { type ActionableErrorCode, isActionableError } from "../utils/actionable-error.js";
import { VERSION } from "../utils/version.js";
import type { TelemetryFailureCategory, TelemetryFailureEvent, TelemetrySink } from "./types.js";

const ACTIONABLE_TO_CATEGORY: Record<ActionableErrorCode, TelemetryFailureCategory> = {
  MISSING_VAULT_PATH: "init/missing-vault-path",
  INIT_TARGET_NOT_EMPTY: "init/target-not-empty",
  CONFIG_PARSE_ERROR: "init/config-parse-error",
  NATIVE_BINDING_LOAD_FAILURE: "init/native-binding-load-failure",
  WIKI_DIR_PERMISSION_DENIED: "init/wiki-dir-permission-denied",
  PORT_IN_USE: "init/port-in-use",
  DAEMON_ALREADY_RUNNING: "init/daemon-already-running",
  // The next three actionable codes can fire outside of init but are
  // mapped for symmetry — when they DO fire during init they categorize
  // sensibly. Init-time emission is gated by the caller; this mapping
  // is just the translation.
  INVALID_API_KEY: "init/runtime-not-detected",
  RATE_LIMITED: "init/runtime-not-detected",
  VAULT_FILE_LOCKED: "init/scaffold-failed",
};

export function categorizeInitFailure(err: unknown): TelemetryFailureCategory {
  if (isActionableError(err)) {
    return ACTIONABLE_TO_CATEGORY[err.code] ?? "init/unknown-failure";
  }
  return "init/unknown-failure";
}

/**
 * Convenience helper: build the full event payload + emit to the sink.
 * Wraps the sink call with try/catch — telemetry must never crash the
 * caller, even on misconfigured sinks.
 */
export function recordInitFailure(
  sink: TelemetrySink,
  err: unknown,
  stage?: string,
): TelemetryFailureEvent {
  const event: TelemetryFailureEvent = {
    category: categorizeInitFailure(err),
    daemonVersion: VERSION,
    platform: platform(),
    arch: arch(),
    nodeVersion: process.version,
    ...(stage !== undefined ? { stage } : {}),
  };
  try {
    sink.recordInitFailure(event);
  } catch {
    // Telemetry failure must NOT propagate.
  }
  return event;
}
