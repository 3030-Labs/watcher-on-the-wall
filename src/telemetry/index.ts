/**
 * Public re-exports for the telemetry module. Other subsystems import
 * the sink + categorizer; never import private modules directly.
 */
export type { TelemetryFailureCategory, TelemetryFailureEvent, TelemetrySink } from "./types.js";
export { MemorySink, NoopSink, SentrySink, getTelemetrySink, validateEvent } from "./sink.js";
export { categorizeInitFailure, recordInitFailure } from "./categorize.js";
