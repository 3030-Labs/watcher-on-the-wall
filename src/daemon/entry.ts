/**
 * Daemon child-process entrypoint. This file is what `spawnDaemon` forks into.
 * It reads environment variables, constructs a Daemon instance, wires up
 * the Phase 2+ subsystems (watcher → ingestion queue → wiki layer), and calls run().
 */
import { Daemon } from "./index.js";
import { LintScheduler } from "./lint-scheduler.js";
import { getLogger } from "../utils/logger.js";
import { WikiStore } from "../wiki/store.js";
import { IndexManager } from "../wiki/index-manager.js";
import { WikiSearch } from "../wiki/search.js";
import { CostTracker } from "../ingestion/cost-tracker.js";
import { DeadLetterQueue } from "../ingestion/dead-letter.js";
import { ModelRouter } from "../ingestion/model-router.js";
import { IngestionQueue } from "../ingestion/queue.js";
import { FileWatcher } from "../watcher/index.js";
import { McpHttpServer } from "../server/index.js";
import { ProvenanceChain } from "../provenance/chain.js";
import { CompoundingEngine } from "../compounding/engine.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) {
      configPath = args[i + 1] ?? null;
      i++;
    }
  }

  const workingDir = process.cwd();

  const daemon = new Daemon({ configPath, workingDir });
  try {
    const config = await daemon.init();
    const log = getLogger("daemon-entry");

    // Resolved by daemon.init() — guaranteed non-null at this point.
    // The runtime mode is forwarded to every subsystem that invokes the
    // agent (ingestion, query, compounding) so they all dispatch through
    // the same execution path.
    const runtimeMode = daemon.getExecutionMode()?.mode ?? "api";

    // Wiki layer
    const store = new WikiStore({ wikiRoot: config.wiki_root });
    await store.ensureLayout();
    const indexManager = new IndexManager(store);
    const search = new WikiSearch();

    // Provenance chain (Phase 4). Initialized before any subsystem that may
    // append to it so early queries/ingestions don't race the file creation.
    let provenance: ProvenanceChain | null = null;
    if (config.provenance.enabled) {
      provenance = new ProvenanceChain({ path: config.provenance.chain_file });
      await provenance.init();
      log.info({ path: provenance.path, records: provenance.count() }, "provenance chain ready");
      if (config.provenance.verify_on_startup) {
        const result = await provenance.verify();
        if (!result.ok) {
          log.fatal({ errors: result.errors.slice(0, 5) }, "provenance chain verification failed");
          throw new Error(
            `Provenance chain is corrupt: ${result.errors.length} error(s). Refusing to start.`,
          );
        }
        log.info(
          { total: result.totalRecords, verified: result.verifiedRecords },
          "provenance chain verified",
        );
      }
    }

    // Ingestion layer
    const costTracker = new CostTracker({
      trackFile: config.cost.track_file,
      maxDailyUsd: config.cost.max_daily_usd,
      maxPerIngestUsd: config.cost.max_per_ingest_usd,
      maxPerQueryUsd: config.cost.max_per_query_usd,
    });
    const modelRouter = new ModelRouter(config);
    // Dead-letter sink for permanently-failed batches (Feature 4). An
    // empty `dead_letter_file` disables the ledger entirely — the queue
    // still constructs the instance, but every write becomes a no-op.
    const deadLetter = new DeadLetterQueue({
      path: config.ingestion.dead_letter_file,
      runtimeMode,
    });
    const ingestion = new IngestionQueue({
      config,
      store,
      indexManager,
      search,
      costTracker,
      modelRouter,
      provenance,
      runtimeMode,
      deadLetter,
    });

    // Compounding engine (Phase 4) — not a subsystem; invoked on demand via
    // the CLI/MCP surface. Shares the same wiki/search/cost instances as
    // the ingestion queue.
    const compounding = new CompoundingEngine({
      config,
      store,
      indexManager,
      search,
      costTracker,
      modelRouter,
      provenance,
      runtimeMode,
    });

    // Watcher layer — hands every flushed batch to the ingestion queue.
    // Forwards runtimeMode so the debounce window is widened in CLI mode.
    const watcher = new FileWatcher({
      config,
      runtimeMode,
      onBatch: async (batch) => {
        await ingestion.enqueue(batch);
      },
    });

    // MCP server layer — bound to the same wiki/ingestion instances.
    const mcp = new McpHttpServer({
      config,
      store,
      indexManager,
      search,
      costTracker,
      modelRouter,
      provenance,
      compounding,
      runtimeMode,
      deadLetter,
    });

    // Feature 1: periodic background lint. Cheap no-op unless
    // `lint.schedule_enabled` is true in config. Runs alongside the
    // ingestion/watcher loop on a timer.
    const lintScheduler = new LintScheduler({ config });

    daemon.attachSubsystem(ingestion);
    daemon.attachSubsystem(watcher);
    daemon.attachSubsystem(mcp);
    daemon.attachSubsystem(lintScheduler);

    // Startup banner (Feature 3). Printed AFTER all subsystems are
    // wired but BEFORE run() blocks, so the operator always sees a
    // single line confirming the MCP URL and runtime mode.
    const mcpUrl = `http://${config.server.host}:${config.server.port}/mcp`;
    log.info(
      {
        mode: runtimeMode,
        mcp: mcpUrl,
        wikiRoot: config.wiki_root,
        deadLetter: deadLetter.enabled ? deadLetter.path : "(disabled)",
        lintSchedule: config.lint.schedule_enabled
          ? `every ${config.lint.interval_hours}h`
          : "(disabled)",
      },
      `Watcher on the Wall started in ${runtimeMode.toUpperCase()} mode — MCP at ${mcpUrl}`,
    );

    await daemon.run();
  } catch (err) {
    const log = getLogger("daemon-entry");
    log.fatal({ err }, "daemon failed to start");
    process.exit(1);
  }
}

void main();
