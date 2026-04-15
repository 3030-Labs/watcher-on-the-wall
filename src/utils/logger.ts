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
export function initLogger(level: LogLevel = "info", logFile?: string): Logger {
  const options: LoggerOptions = {
    level,
    base: { pid: process.pid, hostname: undefined },
    timestamp: pino.stdTimeFunctions.isoTime,
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
