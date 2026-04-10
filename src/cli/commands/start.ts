/**
 * `wotw start` — start the daemon. Supports both foreground and detached modes.
 *
 * Foreground: runs the daemon in this process (Ctrl-C to stop). Useful for dev.
 * Detached:   forks a child process that survives terminal close. Default.
 */
import type { Command } from "commander";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { Daemon } from "../../daemon/index.js";
import { checkDaemonAlive } from "../../daemon/lifecycle.js";
import { spawnDaemon } from "../../daemon/process-manager.js";
import { getLogger } from "../../utils/logger.js";
import { fail, info, success } from "../output.js";

interface StartOptions {
  detach?: boolean;
  foreground?: boolean;
  config?: string;
}

/**
 * Attach the `start` subcommand.
 */
export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .description("Start the watcher-on-the-wall daemon")
    .option("-d, --detach", "Run as a detached background process (default)")
    .option("-f, --foreground", "Run in the foreground (Ctrl-C to stop)")
    .option("-c, --config <path>", "Path to a config file")
    .action(async (opts: StartOptions) => {
      try {
        await runStart(opts);
      } catch (err) {
        fail(`start failed: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Implementation used by the CLI action.
 */
export async function runStart(opts: StartOptions): Promise<void> {
  const foreground = opts.foreground === true;
  const detached = !foreground && opts.detach !== false;

  // Always load config first so we know the PID / log file locations.
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);

  const alive = checkDaemonAlive(config.daemon.pid_file);
  if (alive.alive) {
    info(`Daemon is already running (PID ${alive.pid}).`);
    return;
  }
  if (alive.stale && alive.pid !== null) {
    info(`Stale PID file detected (PID ${alive.pid} no longer alive). Cleaning up.`);
  }

  if (foreground) {
    info("Starting daemon in foreground mode. Press Ctrl-C to stop.");
    const daemon = new Daemon({ configPath: loaded.path, workingDir: process.cwd() });
    await daemon.init();
    await daemon.run();
    return;
  }

  if (detached) {
    info("Starting daemon in detached mode...");
    try {
      const { pid } = await spawnDaemon({
        configPath: loaded.path,
        pidFile: config.daemon.pid_file,
        logFile: config.daemon.log_file,
        workingDir: process.cwd(),
      });
      success(`Daemon started. PID ${pid}.`);
      info(`Logs: ${config.daemon.log_file}`);
      info(`MCP server will bind to http://${config.server.host}:${config.server.port}/mcp`);
    } catch (err) {
      const log = getLogger("cli:start");
      log.error({ err }, "spawnDaemon failed");
      throw err;
    }
  }
}
