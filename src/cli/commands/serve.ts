/**
 * `wotw serve` — standalone MCP server. Does not watch files; only serves the
 * existing wiki to Claude Code sessions over HTTP.
 *
 * Full MCP server wiring lands in Phase 3. In Phase 1 this command reports the
 * correct guidance.
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

  info(`MCP server scaffolding lands in Phase 3.`);
  info(`When implemented, it will bind to http://${host}:${port}/mcp and serve the wiki.`);
}
