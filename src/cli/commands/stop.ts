/**
 * `wotw stop` — gracefully shut down the running daemon by sending SIGTERM.
 */
import type { Command } from "commander";
import { errMsg } from "../../utils/errors.js";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { checkDaemonAlive, removePidFile, terminateAndWait } from "../../daemon/lifecycle.js";
import { fail, info, success, warn } from "../output.js";

interface StopOptions {
  timeout?: string;
  force?: boolean;
}

/**
 * Attach the `stop` subcommand.
 */
export function registerStopCommand(program: Command): void {
  program
    .command("stop")
    .description("Stop the watcher-on-the-wall daemon")
    .option("-t, --timeout <ms>", "Seconds to wait for graceful shutdown", "10")
    .option("-f, --force", "Force-kill (SIGKILL) if graceful shutdown times out")
    .action(async (opts: StopOptions) => {
      try {
        await runStop(opts);
      } catch (err) {
        fail(`stop failed: ${errMsg(err)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Implementation used by the CLI action.
 */
export async function runStop(opts: StopOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);

  const status = checkDaemonAlive(config.daemon.pid_file);
  if (!status.alive) {
    if (status.stale && status.pid !== null) {
      warn(`Stale PID file (PID ${status.pid} not running). Cleaning up.`);
      removePidFile(config.daemon.pid_file);
    } else {
      info("Daemon is not running.");
    }
    return;
  }

  const timeoutMs = Math.max(1, Number(opts.timeout ?? "10")) * 1000;
  info(`Stopping daemon (PID ${status.pid})...`);
  const exited = await terminateAndWait(status.pid as number, timeoutMs);

  if (!exited) {
    if (opts.force) {
      warn("Graceful shutdown timed out. Sending SIGKILL.");
      try {
        process.kill(status.pid as number, "SIGKILL");
      } catch {
        /* ignore */
      }
      removePidFile(config.daemon.pid_file);
      success("Daemon force-killed.");
    } else {
      fail("Daemon did not exit within timeout. Use --force to SIGKILL.");
      process.exitCode = 1;
      return;
    }
  } else {
    removePidFile(config.daemon.pid_file);
    success("Daemon stopped.");
  }
}
