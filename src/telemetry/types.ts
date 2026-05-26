/**
 * Telemetry event categories. Stable enum — categories MUST NOT carry
 * personally identifiable information, vault paths, file contents, API
 * keys, or any user-controlled string. Categories are the entire
 * payload that lands on the user-controlled Sentry project.
 *
 * Adding a new category is a deliberate act: each entry below must be
 * paired with a test that asserts the category is emitted under the
 * documented condition AND that no PII leaks alongside it.
 */
export type TelemetryFailureCategory =
  | "init/missing-vault-path"
  | "init/target-not-empty"
  | "init/config-parse-error"
  | "init/native-binding-load-failure"
  | "init/wiki-dir-permission-denied"
  | "init/port-in-use"
  | "init/daemon-already-running"
  | "init/runtime-not-detected"
  | "init/scaffold-failed"
  | "init/unknown-failure";

/**
 * Telemetry breadcrumb payload. Carries ONLY the fields below; the
 * sink rejects anything else.
 */
export interface TelemetryFailureEvent {
  readonly category: TelemetryFailureCategory;
  readonly daemonVersion: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly nodeVersion: string;
  /**
   * Optional: a short, sanitized hint about which step in the init
   * pipeline failed. MUST be a stable enum-like string with no
   * variable content.
   */
  readonly stage?: string;
}

/**
 * Telemetry sink interface — production uses Sentry, tests use a
 * memory sink for assertion. The sink contract is intentionally
 * minimal: one method, no return value, no async.
 */
export interface TelemetrySink {
  recordInitFailure(event: TelemetryFailureEvent): void;
}
