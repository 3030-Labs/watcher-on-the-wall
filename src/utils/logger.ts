/**
 * Centralized pino logger factory. All modules should import `getLogger()` rather
 * than constructing their own logger so we have one configuration surface.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import pino, { type Logger, type LoggerOptions } from "pino";

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

let rootLogger: Logger | null = null;

/**
 * Initialize the root logger. Idempotent — calling again replaces the existing logger.
 *
 * @param level  minimum log level to emit
 * @param logFile optional path to a log file. If provided, JSON lines are written there.
 *                If omitted, logs go to stdout in pretty format for humans.
 */
/**
 * Pino redact paths — review item 1 closure.
 *
 * Pino's `redact.paths` walks the structured log object before serialization
 * and replaces matching values with `[Redacted]`. We list the common shapes
 * the daemon's log sites produce when error / response objects flow
 * through: headers.authorization, ANTHROPIC_API_KEY-shaped env values,
 * SDK error payloads with embedded keys, etc.
 *
 * This is BELT to the SUSPENDERS of src/utils/sanitize.ts's string-level
 * regex redaction. Sanitize covers free-form text in prompts; redact
 * covers structured fields the call site might have forgotten to pass
 * through sanitize.
 */
const REDACT_PATHS = [
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "req.headers.authorization",
  "req.headers.Authorization",
  "request.headers.authorization",
  "request.headers.Authorization",
  "response.headers.authorization",
  "response.headers.Authorization",
  "headers['x-admin-key']",
  "headers['x-api-key']",
  "headers.cookie",
  "*.headers.cookie",
  "config.api_key",
  "config.headers.authorization",
  "err.config.headers.authorization",
  "err.request.headers.authorization",
  "err.response.headers.authorization",
  // Provider SDK error shapes — observed leaking via err.headers.* on Axios-based clients.
  "err.headers.authorization",
  "err.headers.Authorization",
  // Env-bag dumps (occasionally added by ad-hoc debug logs).
  "env.ANTHROPIC_API_KEY",
  "env.OPENAI_API_KEY",
  "env.GOOGLE_API_KEY",
  "env.ADMIN_SERVICE_KEY",
  "env.WOTW_MCP_BEARER",
  "env.WOTW_INTERNAL_ADMIN_KEY",
  "env.WOTW_CLOUD_SINK_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "ADMIN_SERVICE_KEY",
  "WOTW_MCP_BEARER",
  "WOTW_INTERNAL_ADMIN_KEY",
  "WOTW_CLOUD_SINK_SECRET",
  "apiKey",
  "api_key",
  "*.apiKey",
  "*.api_key",
  "secret",
  "*.secret",
];

export function initLogger(level: LogLevel = "info", logFile?: string): Logger {
  const options: LoggerOptions = {
    level,
    base: { pid: process.pid, hostname: undefined },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: "[Redacted]",
      remove: false,
    },
  };

  if (logFile) {
    mkdirSync(dirname(logFile), { recursive: true });
    rootLogger = pino(options, pino.destination({ dest: logFile, sync: false, mkdir: true }));
  } else {
    rootLogger = pino({
      ...options,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" },
      },
    });
  }
  return rootLogger;
}

/** Default context fields merged into every child logger (e.g. tenantId in hosted mode). */
let defaultContext: Record<string, unknown> = {};

/**
 * Set default context fields that are merged into every child logger.
 * Call once at startup when hosted.enabled is true.
 */
export function setLoggerContext(ctx: Record<string, unknown>): void {
  defaultContext = ctx;
}

/**
 * Return the root logger, initializing with defaults if none exists.
 * When defaultContext has been set (hosted mode), every child logger
 * automatically includes those fields.
 */
export function getLogger(module?: string, extra?: Record<string, unknown>): Logger {
  if (!rootLogger) {
    rootLogger = initLogger("info");
  }
  const ctx = { ...defaultContext, ...extra, ...(module ? { module } : {}) };
  return Object.keys(ctx).length > 0 ? rootLogger.child(ctx) : rootLogger;
}
