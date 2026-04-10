/**
 * `wotw status` — print daemon health, wiki stats, recent events, cost summary.
 *
 * In Phase 1 the stats are sourced directly from the filesystem (PID file + wiki
 * directory counts). In later phases we will also report provenance chain length
 * and recent events from the wiki-events.jsonl log.
 */
import type { Command } from "commander";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import matter from "gray-matter";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { checkDaemonAlive } from "../../daemon/lifecycle.js";
import { sumCostsForDay } from "../../ingestion/cost-tracker.js";
import { DeadLetterQueue } from "../../ingestion/dead-letter.js";
import { box, chalk, info, keyValueTable, line } from "../output.js";

interface StatusOptions {
  json?: boolean;
}

/**
 * Attach the `status` subcommand.
 */
export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show daemon health and wiki stats")
    .option("--json", "Emit machine-readable JSON instead of a pretty table")
    .action(async (opts: StatusOptions) => {
      await runStatus(opts);
    });
}

/**
 * Implementation used by the CLI action.
 */
export async function runStatus(opts: StatusOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const status = checkDaemonAlive(config.daemon.pid_file);

  const wikiRoot = config.wiki_root;
  const pageCount = countMarkdownFiles(join(wikiRoot, "wiki"));
  const orphanedCount = countOrphanedPages(join(wikiRoot, "wiki"));
  const rawCount = countFiles(config.raw_path);
  const provenanceCount = countProvenanceRecords(join(wikiRoot, config.provenance.chain_file));
  // Shared helper from cost-tracker — single source of truth for JSONL
  // parsing (L-CODE-3). Previously `status` re-implemented its own parser
  // which trivially drifted from CostTracker.spentToday().
  const costToday = sumCostsForDay(config.cost.track_file);
  // Dead-letter count — cheap read from the JSONL sink. Empty-path
  // config disables the queue (count() returns 0 without touching disk).
  const deadLetter = new DeadLetterQueue({ path: config.ingestion.dead_letter_file });
  const failedBatches = await deadLetter.count();

  const uptimeSeconds = status.contents
    ? Math.floor((Date.now() - Date.parse(status.contents.started_at)) / 1000)
    : null;

  const payload = {
    running: status.alive,
    pid: status.pid,
    stale_pid_file: status.stale,
    started_at: status.contents?.started_at ?? null,
    uptime_seconds: uptimeSeconds,
    config_path: loaded.path,
    wiki_root: wikiRoot,
    raw_path: config.raw_path,
    server: {
      host: config.server.host,
      port: config.server.port,
    },
    stats: {
      wiki_pages: pageCount,
      orphaned_pages: orphanedCount,
      raw_files: rawCount,
      provenance_records: provenanceCount,
      failed_batches: failedBatches,
      cost_today_usd: Number(costToday.toFixed(4)),
    },
  };

  if (opts.json === true) {
    line(JSON.stringify(payload, null, 2));
    return;
  }

  const running = status.alive ? chalk.green("● running") : chalk.red("● stopped");
  // Compute a quick health summary (no LLM calls — pure computation).
  let healthLine = "—";
  if (pageCount > 0) {
    try {
      const { WikiStore } = await import("../../wiki/store.js");
      const { WikiSearch } = await import("../../wiki/search.js");
      const { loadAllPages } = await import("../../ingestion/wiki-writer.js");
      const { computeHealthReport } = await import("../../wiki/health.js");
      const store = new WikiStore({ wikiRoot });
      const search = new WikiSearch();
      const allPages = await loadAllPages(store);
      search.rebuild(allPages);
      const report = await computeHealthReport(store, null, search, { config });
      const avg =
        report.scores.length > 0
          ? Math.round(report.scores.reduce((s, p) => s + p.score, 0) / report.scores.length)
          : 0;
      const belowFifty = report.scores.filter((s) => s.score < 50).length;
      healthLine = `${avg} avg`;
      if (belowFifty > 0) healthLine += chalk.yellow(` (${belowFifty} need attention)`);
    } catch {
      healthLine = "error computing";
    }
  }

  const rows: Array<[string, string]> = [
    ["status", running],
    ["pid", status.pid !== null ? String(status.pid) : "—"],
    ["started", status.contents?.started_at ?? "—"],
    ["uptime", uptimeSeconds !== null ? formatDuration(uptimeSeconds) : "—"],
    ["config", loaded.path ?? "(defaults)"],
    ["wiki root", wikiRoot],
    ["raw path", config.raw_path],
    ["server", `http://${config.server.host}:${config.server.port}/mcp`],
    ["wiki pages", String(pageCount)],
    [
      "orphaned pages",
      orphanedCount > 0 ? chalk.yellow(String(orphanedCount)) : String(orphanedCount),
    ],
    ["wiki health", healthLine],
    ["raw files", String(rawCount)],
    ["provenance records", String(provenanceCount)],
    [
      "failed batches",
      failedBatches > 0 ? chalk.red(String(failedBatches)) : String(failedBatches),
    ],
    ["cost today", `$${costToday.toFixed(4)}`],
  ];
  box(keyValueTable(rows), "watcher-on-the-wall");
  if (failedBatches > 0) {
    info(
      `${failedBatches} permanently-failed batch(es) in ${config.ingestion.dead_letter_file}. ` +
        `Inspect with 'wotw logs' or replay manually.`,
    );
  }

  if (status.stale) {
    info("A stale PID file was detected and is being ignored. Run `wotw start` to relaunch.");
  }
}

function countMarkdownFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else if (s.isFile() && name.endsWith(".md")) count++;
    }
  };
  walk(dir);
  return count;
}

/**
 * Count wiki pages whose frontmatter is marked `status: orphaned`. Uses
 * gray-matter directly instead of going through parsePage so we don't
 * pay for body parsing on pages we only peek at. Best-effort: anything
 * that fails to parse is ignored.
 */
function countOrphanedPages(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) {
        walk(full);
        continue;
      }
      if (!s.isFile() || !name.endsWith(".md")) continue;
      try {
        const raw = readFileSync(full, "utf8");
        const parsed = matter(raw);
        if ((parsed.data as Record<string, unknown>).status === "orphaned") count++;
      } catch {
        /* ignore — a partially-written file should not break `status` */
      }
    }
  };
  walk(dir);
  return count;
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const walk = (d: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = join(d, name);
      let s: ReturnType<typeof statSync>;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else if (s.isFile()) count++;
    }
  };
  walk(dir);
  return count;
}

function countProvenanceRecords(chainFile: string): number {
  if (!existsSync(chainFile)) return 0;
  try {
    const text = readFileSync(chainFile, "utf8");
    return text.split("\n").filter((l) => l.trim().length > 0).length;
  } catch {
    return 0;
  }
}

function formatDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
