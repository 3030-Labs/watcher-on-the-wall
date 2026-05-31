/**
 * Daemon child-process entrypoint. This file is what `spawnDaemon` forks into.
 * It reads environment variables, constructs a Daemon instance, wires up
 * the Phase 2+ subsystems (watcher → ingestion queue → wiki layer), and calls run().
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { Daemon } from "./index.js";
import { LintScheduler } from "./lint-scheduler.js";
import { DekArchiveScheduler } from "./dek-archive-scheduler.js";
import { getLogger, initLogger, setLoggerContext } from "../utils/logger.js";
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
import { RedactionEmitStore } from "../provenance/redaction-emit-store.js";
import { RedactionEmitWorker } from "../provenance/redaction-emit-worker.js";
import { redactionSinkFromEnv } from "../provenance/redaction-sink.js";
import type { KeyStore as KeyStoreType } from "../keys/store.js";
import { CompoundingEngine } from "../compounding/engine.js";

async function main(): Promise<void> {
  // Early fallback logger so daemon.init() failures are captured to disk.
  // Review item 7: in hosted mode the docker entrypoint cd's into
  // WIKI_ROOT before calling main(), so process.cwd() points at the
  // persistent Fly volume. A boot-failure log written there bloats
  // tenant storage with noise the user cannot inspect. Use /tmp in
  // hosted mode (ephemeral, only relevant if the real logger can't
  // come up anyway). Outside hosted mode, keep cwd to stay portable.
  const isHosted = process.env.WOTW_HOSTED === "true" || process.env.WOTW_HOSTED === "1";
  const fallbackLogDir = isHosted ? "/tmp/wotw" : `${process.cwd()}/.wotw`;
  const fallbackLogPath = `${fallbackLogDir}/daemon.log`;
  try {
    mkdirSync(fallbackLogDir, { recursive: true });
    initLogger("info", fallbackLogPath);
  } catch {
    try {
      mkdirSync(fallbackLogDir, { recursive: true });
      writeFileSync(
        fallbackLogPath,
        `[${new Date().toISOString()}] FATAL: failed to initialize fallback logger\n`,
        { flag: "a" },
      );
    } catch {
      /* nothing more we can do */
    }
  }

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

    // Hosted mode: tag every log line with the tenant ID
    if (config.hosted.enabled && config.hosted.tenant_id) {
      setLoggerContext({ tenantId: config.hosted.tenant_id });
    }

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
    // PASS-019 Part C: hoisted out of the provenance-enabled block so the
    // DEK auto-archive scheduler below can reference them.
    let keyStore: KeyStoreType | null = null;
    let workspaceId: string | undefined;
    if (config.provenance.enabled) {
      // Hosted-mode cloud sink (SD-1 closure, Pass-pair with wotw-cloud
      // /api/internal/append-provenance). Sink is null in local /
      // interactive mode where WOTW_WIKI_ID + ADMIN_SERVICE_KEY aren't set;
      // JSONL-only operation continues with no errors.
      const { cloudSinkFromEnv } = await import("../provenance/cloud-sink.js");
      const sink = cloudSinkFromEnv();
      if (sink) {
        log.info(
          { wikiId: sink.wikiId, apiBaseUrl: sink.apiBaseUrl },
          "provenance cloud sink active",
        );
      }
      // G5 closure (Pass 018, v0.8.2): workspace KeyStore for end-to-end
      // attestation. Provisions a per-workspace DEK encrypted under a
      // KEK from Fly secrets (WOTW_WORKSPACE_KEK). Each chain append
      // signs with the active DEK and stamps `key_id` so verify can
      // look up the right DEK after rotation. Opt-in: requires both
      // hosted mode (workspace_id from tenant_id) AND the KEK env var.
      // Without these, ProvenanceChain falls back to the v0.8.1
      // single-key 4-tier resolution.
      const tenantId =
        config.hosted.enabled && config.hosted.tenant_id ? config.hosted.tenant_id : undefined;
      workspaceId = tenantId;
      if (tenantId && process.env.WOTW_WORKSPACE_KEK) {
        const { readKekFromEnv } = await import("../keys/envelope.js");
        const { KeyStore } = await import("../keys/store.js");
        try {
          const kek = readKekFromEnv();
          keyStore = new KeyStore({ path: `${config.wiki_root}/.wotw/keys.db`, kek });
          const existing = keyStore.active(tenantId);
          if (existing) {
            log.info(
              { keyId: existing.key_id.slice(0, 8), workspaceId: tenantId },
              "workspace key store ready (existing active DEK)",
            );
          } else {
            const provisioned = keyStore.provision(tenantId);
            log.info(
              { keyId: provisioned.key_id.slice(0, 8), workspaceId: tenantId },
              "workspace key store ready (new DEK provisioned)",
            );
          }
        } catch (err) {
          log.fatal(
            { err: err instanceof Error ? err.message : String(err) },
            "workspace key store init failed; refusing to start with attestation enabled but broken",
          );
          throw err;
        }
      }
      provenance = new ProvenanceChain({
        path: config.provenance.chain_file,
        sink,
        // Review items 42 + 43: tenant_id folds into canonical payload;
        // HMAC key falls back to a per-tenant derivation when no explicit
        // env override is set. Together these make forge / delete /
        // cross-tenant-replay detectable.
        tenantId,
        workspaceId: tenantId,
        keyStore,
      });
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

    // FEATURE-PASS-011: redaction-emit substrate. The SQLite queue is
    // constructed unconditionally so credential-pattern + truncation_32kb
    // events captured in prompt-builder always have a durable home; the
    // sink + worker only come up when WOTW_WIKI_ID + WOTW_CLOUD_SINK_SECRET
    // are both present (hosted-mode invariant pre-validated by
    // validateHostedRedactionSink in src/daemon/config.ts). In hosted-mode-
    // with-cloud-down the worker accumulates rows and retries with
    // exponential backoff; in local mode the worker is a no-op.
    const redactionEmitStore = new RedactionEmitStore({
      path: `${config.wiki_root}/.wotw/redaction-emit.db`,
    });
    const redactionWorkspaceId = process.env.WOTW_WIKI_ID;
    const redactionSink = redactionSinkFromEnv();
    const redactionEmitWorker = new RedactionEmitWorker({
      store: redactionEmitStore,
      sink: redactionSink,
    });
    log.info(
      {
        path: redactionEmitStore.path,
        sinkActive: !!redactionSink,
        workspaceId: redactionWorkspaceId ?? null,
        counts: redactionEmitStore.countByStatus(),
      },
      "redaction-emit store ready",
    );

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
    // Pass B fact-extraction sidecar. Persistent SQLite at
    // <wiki_root>/.wotw/facts.db, with a parallel in-memory minisearch
    // index loaded from the live rows. Best-effort: extraction is gated
    // by `fact_extraction.enabled` + runtime cost-freeness, and any
    // failure inside the layer never breaks ingestion.
    const { FactStore } = await import("../facts/store.js");
    const { FactIndex } = await import("../facts/index-manager.js");
    const { isExtractionActive } = await import("../facts/extractor.js");
    const factsDbPath = `${config.wiki_root}/.wotw/facts.db`;
    const factStore = new FactStore({ path: factsDbPath });
    const factIndex = new FactIndex();
    try {
      factIndex.rebuild(factStore.listActive(), factStore.listActiveQuestions());
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "facts.db: initial index rebuild failed; layer will be empty until next reindex",
      );
    }
    const extractionStatus = isExtractionActive(config, runtimeMode);
    log.info(
      {
        active: extractionStatus.active,
        reason: extractionStatus.reason,
        path: factsDbPath,
        facts: factIndex.size(),
        questions: factIndex.questionCount(),
      },
      "fact-extraction layer status",
    );

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
      factStore,
      factIndex,
      redactionEmitStore,
      redactionWorkspaceId,
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
        const outcome = await ingestion.enqueue(batch);
        // Review item 25: when ingestion skipped for budget reasons,
        // signal retainForRetry so the watcher does NOT mark the files
        // as processed. Otherwise budget-skipped files would be silently
        // lost (never re-tried tomorrow when the daily window resets).
        if (
          outcome?.skipped === true &&
          typeof outcome.skipReason === "string" &&
          /budget|cap|exceeds/i.test(outcome.skipReason)
        ) {
          return { retainForRetry: true };
        }
        return undefined;
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
      factStore,
      factIndex,
    });

    // Feature 1: periodic background lint. Cheap no-op unless
    // `lint.schedule_enabled` is true in config. Runs alongside the
    // ingestion/watcher loop on a timer.
    const lintScheduler = new LintScheduler({ config });

    // PASS-019 Part C: DEK auto-archive cron. Hourly tick scans
    // workspace_keys for `rotating` DEKs past their overlap window
    // (default 24h, configurable via WOTW_DEK_OVERLAP_HOURS) and
    // transitions them to `archived`. No-op unless keyStore is set
    // (hosted mode + WOTW_WORKSPACE_KEK present). Idempotent.
    const dekArchiveScheduler =
      keyStore && workspaceId ? new DekArchiveScheduler({ keyStore, workspaceId }) : null;

    daemon.attachSubsystem(ingestion);
    daemon.attachSubsystem(watcher);
    daemon.attachSubsystem(mcp);
    daemon.attachSubsystem(lintScheduler);
    if (dekArchiveScheduler) daemon.attachSubsystem(dekArchiveScheduler);
    daemon.attachSubsystem(redactionEmitWorker);

    // Review item 23: startReconciliation was defined + tested but
    // never called. The watcher relies on it to catch files dropped
    // into raw/ during daemon downtime (chokidar's initial-add events
    // fire on startup, but only once). Without a periodic reconcile
    // pass, any file the watcher's `processedPaths` Set already saw
    // and that gets re-touched, deleted, or replaced during a brief
    // hiccup is silently lost. 5-minute interval matches review intent.
    watcher.startReconciliation(5 * 60 * 1000);

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
