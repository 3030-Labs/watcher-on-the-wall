/**
 * `wotw serve` — standalone MCP server. Does not watch files; only serves the
 * existing wiki to Claude Code sessions over HTTP.
 *
 * The full MCP server is implemented in `src/server/index.ts` and is started
 * automatically by `wotw start`. This standalone serve command is reserved for
 * future use as a lightweight server-only mode without the watcher/daemon.
 */
import type { Command } from "commander";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { info } from "../output.js";

interface ServeOptions {
  port?: string;
  host?: string;
}

/**
 * Attach the `serve` subcommand.
 */
export function registerServeCommand(program: Command): void {
  program
    .command("serve")
    .description("Start a standalone MCP server (no watcher, no daemon)")
    .option("-p, --port <port>", "Port to bind (overrides config)")
    .option("-h, --host <host>", "Host to bind (overrides config)")
    .action(async (opts: ServeOptions) => {
      await runServe(opts);
    });
}

export async function runServe(opts: ServeOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const host = opts.host ?? config.server.host;
  const port = opts.port ? Number(opts.port) : config.server.port;

  info(`The standalone MCP server is not yet available as a separate command.`);
  info(
    `Use 'wotw start' to launch the full daemon (watcher + MCP server) at http://${host}:${port}/mcp.`,
  );
}
