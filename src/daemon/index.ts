/**
 * Daemon main loop. Initializes subsystems, wires up signal handlers, and keeps
 * the event loop alive until a graceful shutdown is requested.
 *
 * In Phase 1 the daemon owns the PID file, logger, and signal handlers. Phases 2-4
 * progressively attach watcher, ingestion, MCP server, and provenance subsystems
 * by calling {@link Daemon.attachSubsystem}.
 */
import { loadConfig, resolveConfigPaths } from "./config.js";
import { acquireStartLock, checkDaemonAlive, removePidFile, writePidFile } from "./lifecycle.js";
import { getLogger, initLogger } from "../utils/logger.js";
import type { WotwConfig } from "../utils/types.js";
import {
  daemonAlreadyRunningError,
  looksLikePermissionDenied,
  wikiDirPermissionError,
} from "../utils/actionable-error.js";
import { ensureDirSync } from "../utils/fs.js";

function ensureDirSyncOrActionable(path: string): void {
  try {
    ensureDirSync(path);
  } catch (err) {
    if (looksLikePermissionDenied(err)) {
      throw wikiDirPermissionError(path, err);
    }
    throw err;
  }
}
import { VERSION } from "../utils/version.js";
import {
  resolveExecutionMode,
  type ResolvedExecutionMode,
  ExecutionModeError,
} from "../ingestion/execution-mode.js";

/** A daemon subsystem that can start and stop cleanly. */
export interface DaemonSubsystem {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface DaemonOptions {
  configPath: string | null;
  workingDir: string;
}

/**
 * The Daemon class holds runtime state and coordinates subsystem lifecycle.
 */
export class Daemon {
  private readonly subsystems: DaemonSubsystem[] = [];
  private shuttingDown = false;
  private readonly opts: DaemonOptions;
  private config: WotwConfig | null = null;
  private executionMode: ResolvedExecutionMode | null = null;
  private releaseLock: (() => Promise<void>) | null = null;

  constructor(opts: DaemonOptions) {
    this.opts = opts;
  }

  /** Resolve config and return it. */
  async init(): Promise<WotwConfig> {
    const loaded = await loadConfig(this.opts.workingDir);
    this.config = resolveConfigPaths(loaded.config, this.opts.workingDir);

    // Initialize logger against the resolved log file
    initLogger(this.config.daemon.log_level, this.config.daemon.log_file);
    const log = getLogger("daemon");
    log.info(
      {
        pid: process.pid,
        cwd: this.opts.workingDir,
        configPath: loaded.path,
      },
      "daemon initializing",
    );

    ensureDirSyncOrActionable(this.config.wiki_root);
    ensureDirSyncOrActionable(this.config.raw_path);

    // Resolve execution mode BEFORE starting any subsystem. If neither a
    // claude CLI binary nor an API key is available, refuse to start with a
    // precise error message — downstream code would crash in confusing ways
    // without this guard.
    try {
      this.executionMode = resolveExecutionMode(this.config);
    } catch (err) {
      if (err instanceof ExecutionModeError) {
        log.fatal({ code: err.code }, err.message);
      } else {
        log.fatal({ err }, "failed to resolve execution mode");
      }
      throw err;
    }
    // Log the resolved mode prominently so the user always knows which
    // runtime is active and what it costs.
    log.info(
      {
        mode: this.executionMode.mode,
        configured: this.executionMode.configuredMode,
        cliPath: this.executionMode.cliPath,
        apiKeyEnv: this.executionMode.apiKeyEnv,
        model: this.executionMode.effectiveModelHint,
      },
      this.executionMode.description,
    );

    return this.config;
  }

  /** Return the resolved execution mode, or null if init() hasn't run yet. */
  getExecutionMode(): ResolvedExecutionMode | null {
    return this.executionMode;
  }

  /** Attach a subsystem for start/stop management. */
  attachSubsystem(sub: DaemonSubsystem): void {
    this.subsystems.push(sub);
  }

  /**
   * Main run loop. Acquires the start lock, writes the PID file, starts all
   * subsystems, installs signal handlers, and blocks until shutdown.
   */
  async run(): Promise<void> {
    if (!this.config) throw new Error("Daemon.init() must be called before run()");
    const log = getLogger("daemon");

    // Guard against double-start
    const alive = checkDaemonAlive(this.config.daemon.pid_file);
    if (alive.alive) {
      log.error({ pid: alive.pid }, "another daemon instance is already running");
      throw daemonAlreadyRunningError(this.config.daemon.pid_file);
    }

    // Acquire lock to prevent simultaneous starts
    try {
      this.releaseLock = await acquireStartLock(this.config.daemon.lock_file);
    } catch (err) {
      log.error({ err }, "failed to acquire start lock");
      throw daemonAlreadyRunningError(this.config.daemon.lock_file, err);
    }

    // Write PID file
    writePidFile(this.config.daemon.pid_file, {
      pid: process.pid,
      started_at: new Date().toISOString(),
      version: VERSION,
    });
    log.info({ pidFile: this.config.daemon.pid_file }, "PID file written");

    // Install signal handlers BEFORE starting subsystems so any crash during
    // startup is handled cleanly.
    this.installSignalHandlers();

    // Start subsystems in order
    for (const sub of this.subsystems) {
      try {
        log.info({ subsystem: sub.name }, "starting subsystem");
        await sub.start();
      } catch (err) {
        log.error({ err, subsystem: sub.name }, "subsystem failed to start");
        await this.shutdown(1);
        return;
      }
    }

    log.info({ subsystems: this.subsystems.map((s) => s.name) }, "daemon running");

    // Block until shutdown. The check interval intentionally does NOT unref,
    // so it keeps the event loop alive even when no subsystems are attached.
    // Once this.shuttingDown flips true we clear it and resolve.
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (this.shuttingDown) {
          clearInterval(check);
          resolve();
        }
      }, 250);
    });
  }

  /** Install SIGTERM / SIGINT handlers for graceful shutdown. */
  private installSignalHandlers(): void {
    const handle = (signal: NodeJS.Signals): void => {
      const log = getLogger("daemon");
      log.info({ signal }, "received shutdown signal");
      void this.shutdown(0);
    };
    process.on("SIGTERM", handle);
    process.on("SIGINT", handle);
    process.on("uncaughtException", (err) => {
      const log = getLogger("daemon");
      log.fatal({ err }, "uncaught exception");
      void this.shutdown(1);
    });
    process.on("unhandledRejection", (reason) => {
      const log = getLogger("daemon");
      log.fatal(
        { reason: reason instanceof Error ? reason.message : String(reason) },
        "unhandled rejection — shutting down",
      );
      void this.shutdown(1);
    });
  }

  /** Stop all subsystems, release the lock, remove the PID file, and exit. */
  async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const log = getLogger("daemon");
    log.info("daemon shutting down");

    // Stop subsystems in reverse order
    for (const sub of [...this.subsystems].reverse()) {
      try {
        await sub.stop();
        log.info({ subsystem: sub.name }, "subsystem stopped");
      } catch (err) {
        log.error({ err, subsystem: sub.name }, "subsystem stop failed");
      }
    }

    // Remove PID file
    if (this.config) {
      removePidFile(this.config.daemon.pid_file);
    }

    // Release lock
    if (this.releaseLock) {
      try {
        await this.releaseLock();
      } catch {
        /* ignore */
      }
    }

    log.info("daemon shutdown complete");
    // Give pino a tick to flush
    await new Promise((r) => setTimeout(r, 50));
    process.exit(exitCode);
  }
}
