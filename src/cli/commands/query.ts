/**
 * `wotw query "question"` — query the running daemon's MCP server over HTTP.
 *
 * This issues a single JSON-RPC call to the `query` tool and pretty-prints
 * the answer. If no daemon is running we tell the user to start one.
 */
import type { Command } from "commander";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { checkDaemonAlive } from "../../daemon/lifecycle.js";
import { callMcpTool } from "./lib/mcp-client.js";
import { box, fail, info, line } from "../output.js";

interface QueryOptions {
  json?: boolean;
  k?: string;
}

/**
 * Attach the `query` subcommand.
 */
export function registerQueryCommand(program: Command): void {
  program
    .command("query <question>")
    .description("Ask the wiki a natural-language question")
    .option("--json", "Emit JSON instead of prose")
    .option("-k, --k <count>", "Number of retrieved pages to use (1-20)", "8")
    .action(async (question: string, opts: QueryOptions) => {
      await runQuery(question, opts);
    });
}

/** Query implementation. */
export async function runQuery(question: string, opts: QueryOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const status = checkDaemonAlive(config.daemon.pid_file);

  if (!status.alive) {
    fail("No daemon is running. Start one with `wotw start`.");
    process.exitCode = 1;
    return;
  }

  const k = Math.max(1, Math.min(20, Number(opts.k) || 8));
  info(`Asking the wiki...`);
  try {
    const result = await callMcpTool({
      host: config.server.host,
      port: config.server.port,
      authToken: config.server.auth_token,
      tool: "query",
      args: { question, k },
    });
    if (opts.json) {
      line(JSON.stringify(result, null, 2));
      return;
    }
    const text = extractText(result);
    box(text || "(no answer)", "answer");
  } catch (err) {
    fail(`Query failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function extractText(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[] };
  if (!r?.content) return "";
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n\n");
}
