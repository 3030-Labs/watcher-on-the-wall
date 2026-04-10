/**
 * `wotw synthesize` — trigger a compounding synthesis pass on the running
 * daemon. The daemon does the actual work (so we get concurrency safety,
 * budget tracking, and provenance all for free); the CLI is a thin
 * trigger + result formatter.
 */
import type { Command } from "commander";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { checkDaemonAlive } from "../../daemon/lifecycle.js";
import { callMcpTool } from "./lib/mcp-client.js";
import { chalk, fail, info, keyValueTable, line, success, warn } from "../output.js";

interface SynthesizeOptions {
  json?: boolean;
}

interface ClusterSummary {
  tag: string;
  pages: string[];
  synthesisPath: string | null;
  skipped: boolean;
  reason?: string;
}

interface SynthesizeResult {
  skipped: boolean;
  skip_reason: string | null;
  clusters: ClusterSummary[];
  pages_written: number;
  cost_usd: number;
  git_sha: string | null;
  duration_ms: number;
}

/**
 * Attach the `synthesize` subcommand.
 */
export function registerSynthesizeCommand(program: Command): void {
  program
    .command("synthesize")
    .description("Run a compounding synthesis pass over the wiki")
    .option("--json", "Emit JSON instead of pretty output")
    .action(async (opts: SynthesizeOptions) => {
      await runSynthesize(opts);
    });
}

export async function runSynthesize(opts: SynthesizeOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const status = checkDaemonAlive(config.daemon.pid_file);

  if (!status.alive) {
    fail("No daemon is running. Start one with `wotw start`.");
    process.exitCode = 1;
    return;
  }

  info("Running synthesis pass (this may take a while)...");
  try {
    const result = await callMcpTool({
      host: config.server.host,
      port: config.server.port,
      authToken: config.server.auth_token,
      tool: "synthesize",
      args: {},
      // Synthesis can take several minutes for large wikis. 10m is generous.
      timeoutMs: 10 * 60 * 1000,
    });
    const payload = extractPayload(result);
    if (!payload) {
      fail("Synthesis returned no payload.");
      process.exitCode = 1;
      return;
    }
    if (opts.json) {
      line(JSON.stringify(payload, null, 2));
      return;
    }
    printSynthesizeResult(payload);
  } catch (err) {
    fail(`Synthesis failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

function printSynthesizeResult(result: SynthesizeResult): void {
  line("");
  if (result.skipped) {
    warn(`Skipped: ${result.skip_reason ?? "unknown reason"}`);
    return;
  }
  line(
    keyValueTable([
      ["clusters examined", String(result.clusters.length)],
      ["pages written", String(result.pages_written)],
      ["cost", `$${result.cost_usd.toFixed(4)}`],
      ["git sha", result.git_sha ?? "—"],
      ["duration", `${(result.duration_ms / 1000).toFixed(1)}s`],
    ]),
  );
  line("");
  if (result.clusters.length === 0) {
    info("No clusters met the threshold.");
    return;
  }
  for (const c of result.clusters) {
    if (c.skipped) {
      line(
        `  ${chalk.dim("○")} ${chalk.bold(c.tag.padEnd(20))} ${chalk.dim(`${c.pages.length} pages`)} — ${chalk.dim(c.reason ?? "skipped")}`,
      );
    } else {
      line(
        `  ${chalk.green("●")} ${chalk.bold(c.tag.padEnd(20))} ${chalk.dim(`${c.pages.length} pages`)} → ${chalk.cyan(c.synthesisPath ?? "")}`,
      );
    }
  }
  line("");
  if (result.pages_written > 0) {
    success(`Wrote ${result.pages_written} synthesis page(s).`);
  } else {
    info("No new synthesis pages written.");
  }
}

interface McpContentBlock {
  type?: string;
  text?: string;
}

/** Extract the synthesize payload from the MCP tool result envelope. */
function extractPayload(result: unknown): SynthesizeResult | null {
  const r = result as { content?: McpContentBlock[] };
  const text = r?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as SynthesizeResult;
  } catch {
    return null;
  }
}
