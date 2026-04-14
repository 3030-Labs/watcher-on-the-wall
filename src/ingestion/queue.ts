/**
 * Ingestion queue. p-queue with concurrency:1 ensures batches are processed
 * strictly in order. Each enqueued batch goes through:
 *
 *   1. Budget check (cost-tracker)
 *   2. Prompt construction (prompt-builder)
 *   3. Agent invocation (llm-invoker)
 *   4. Wiki reconciliation (wiki-writer)
 *   5. Bidirectional link repair (cross-reference)
 *   6. Index rebuild + search reindex
 *   7. Cost logging
 *   8. Git commit
 *
 * The queue is a {@link DaemonSubsystem}. start() is a no-op today — we
 * don't open network connections until a batch arrives. stop() drains any
 * in-flight work with a timeout so shutdown is responsive.
 */
import { relative, resolve } from "node:path";
import PQueue from "p-queue";
import { errMsg } from "../utils/errors.js";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import type { DaemonSubsystem } from "../daemon/index.js";
import type { IndexManager } from "../wiki/index-manager.js";
import { repairBidirectionalLinks } from "../wiki/cross-reference.js";
import type { WikiSearch } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import type { WatcherBatch } from "../watcher/index.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256File, sha256Files, sha256Hex } from "../provenance/hash.js";
import type { CostTracker } from "./cost-tracker.js";
import type { DeadLetterQueue } from "./dead-letter.js";
import { commitWikiChanges } from "./git-committer.js";
import { invokeIngestionAgent } from "./llm-invoker.js";
import type { ModelRouter } from "./model-router.js";
import { buildIngestionPrompt } from "./prompt-builder.js";
import { TenantScheduler } from "./tenant-scheduler.js";
import { loadAllPages, reconcileWrittenPages } from "./wiki-writer.js";

export interface IngestionQueueOptions {
  config: WotwConfig;
  store: WikiStore;
  indexManager: IndexManager;
  search: WikiSearch;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  /** Optional provenance chain — if provided, each batch appends a record. */
  provenance?: ProvenanceChain | null;
  /**
   * Resolved runtime mode. Defaults to "api" so legacy callers and test rigs
   * keep working without change. When set to "cli" the queue spawns the
   * `claude` binary for every batch and logs cost=0 (subscription-covered).
   */
  runtimeMode?: RuntimeMode;
  /**
   * Optional dead-letter sink. When provided, catch blocks that previously
   * dropped a failed batch with only a log line now persist the failure to
   * a JSONL ledger so operators can inspect it and replay later.
   */
  deadLetter?: DeadLetterQueue | null;
}

export interface IngestionOutcome {
  batchId: string;
  skipped: boolean;
  skipReason?: string;
  pagesWritten: number;
  costUsd: number;
  gitSha: string | null;
  durationMs: number;
}

export class IngestionQueue implements DaemonSubsystem {
  readonly name = "ingestion";
  private readonly opts: IngestionQueueOptions;
  private readonly queue: PQueue;
  /** Tenant-aware scheduler used when `hosted.enabled: true`. */
  private readonly tenantScheduler: TenantScheduler | null;
  private resumeSessionId: string | null = null;
  /** Last enqueued outcome — exposed for tests. */
  private lastOutcome: IngestionOutcome | null = null;

  constructor(opts: IngestionQueueOptions) {
    this.opts = opts;
    this.queue = new PQueue({ concurrency: 1 });

    // In hosted mode, construct a TenantScheduler that manages per-tenant
    // subqueues with round-robin fairness and concurrency caps. The p-queue
    // stays as a fallback for single-user mode.
    const hosted = opts.config.hosted;
    if (hosted.enabled && hosted.tenant_id) {
      const pausedState = new Map<string, boolean>();
      if (hosted.paused) pausedState.set(hosted.tenant_id, true);
      this.tenantScheduler = new TenantScheduler({
        globalConcurrency: hosted.concurrency_cap,
        getConcurrencyCap: () => hosted.concurrency_cap,
        isPaused: (tid) => pausedState.get(tid) ?? false,
      });
      // Expose setPaused so the admin API can toggle it at runtime
      (this as { _pausedState?: Map<string, boolean> })._pausedState = pausedState;
    } else {
      this.tenantScheduler = null;
    }
  }

  async start(): Promise<void> {
    const log = getLogger("ingestion");
    if (this.tenantScheduler) {
      const hosted = this.opts.config.hosted;
      log.info(
        {
          tenantId: hosted.tenant_id,
          concurrencyCap: hosted.concurrency_cap,
          paused: hosted.paused,
        },
        "ingestion queue ready (hosted mode)",
      );
      if (hosted.paused) {
        log.warn(
          { tenantId: hosted.tenant_id },
          "tenant is paused — ingestion jobs will be held until unpaused",
        );
      }
    } else {
      log.info("ingestion queue ready");
    }
    // Eagerly rebuild search + index so queries are immediately useful
    // even before the first batch lands.
    await this.opts.store.ensureLayout();
    const pages = await loadAllPages(this.opts.store);
    this.opts.search.rebuild(pages);
    await this.opts.indexManager.rebuild(pages);
    log.info({ pages: pages.length }, "initial wiki scan complete");
  }

  async stop(): Promise<void> {
    const log = getLogger("ingestion");
    if (this.tenantScheduler) {
      log.info("stopping tenant scheduler");
      this.tenantScheduler.stop();
      const drainTimeout = 5_000;
      await Promise.race([
        this.tenantScheduler.drain(),
        new Promise<void>((r) => setTimeout(r, drainTimeout)),
      ]);
    } else {
      log.info(
        { pending: this.queue.size, active: this.queue.pending },
        "draining ingestion queue",
      );
      this.queue.pause();
      const drainTimeout = 5_000;
      await Promise.race([
        this.queue.onIdle(),
        new Promise<void>((r) => setTimeout(r, drainTimeout)),
      ]);
      this.queue.clear();
    }
  }

  /** Enqueue a batch. Returns a promise that resolves with the outcome. */
  enqueue(batch: WatcherBatch): Promise<IngestionOutcome> {
    const processWithCatch = async (): Promise<IngestionOutcome> => {
      try {
        return await this.process(batch);
      } catch (err) {
        const log = getLogger("ingestion");
        log.error({ err, batchId: batch.id }, "batch processing threw");
        if (this.opts.deadLetter) {
          await this.opts.deadLetter.record(batch, err, "add");
        }
        const outcome: IngestionOutcome = {
          batchId: batch.id,
          skipped: true,
          skipReason: `process error: ${errMsg(err)}`,
          pagesWritten: 0,
          costUsd: 0,
          gitSha: null,
          durationMs: 0,
        };
        this.lastOutcome = outcome;
        return outcome;
      }
    };

    // In hosted mode, route through the tenant scheduler for fair scheduling.
    // In single-user mode, use the existing p-queue.
    if (this.tenantScheduler && this.opts.config.hosted.tenant_id) {
      return new Promise<IngestionOutcome>((resolve) => {
        this.tenantScheduler!.enqueue({
          tenantId: this.opts.config.hosted.tenant_id!,
          batchId: batch.id,
          execute: async () => {
            const result = await processWithCatch();
            resolve(result);
            return result;
          },
        });
      });
    }

    return this.queue.add(processWithCatch) as Promise<IngestionOutcome>;
  }

  /** Number of pending batches waiting on the queue. */
  pendingCount(): number {
    if (this.tenantScheduler) return this.tenantScheduler.getTotalQueueDepth();
    return this.queue.size;
  }

  /** Expose the last outcome (for debugging / tests). */
  getLastOutcome(): IngestionOutcome | null {
    return this.lastOutcome;
  }

  private async process(batch: WatcherBatch): Promise<IngestionOutcome> {
    const log = getLogger("ingestion");
    const started = Date.now();
    const runtimeMode: RuntimeMode = this.opts.runtimeMode ?? "api";
    // In CLI mode, the daemon uses a single Sonnet model for every operation
    // (the subscription covers it). In API mode, the model-router picks
    // Haiku for ingestion to keep costs down.
    const model =
      runtimeMode === "cli"
        ? this.opts.config.execution.cli_model
        : this.opts.modelRouter.modelFor("ingest");

    log.info(
      {
        batchId: batch.id,
        fileCount: batch.paths.length,
        deletes: batch.deletedPaths.length,
        model,
        runtimeMode,
      },
      "processing batch",
    );

    // Deletion-only batch: skip the entire LLM pipeline and archive the
    // affected wiki pages directly. The archive path costs nothing to run
    // and records an "archive" provenance entry per batch.
    if (batch.paths.length === 0 && batch.deletedPaths.length > 0) {
      const archived = await this.archiveDeletedSources(batch.deletedPaths, batch);
      const outcome: IngestionOutcome = {
        batchId: batch.id,
        skipped: false,
        pagesWritten: archived,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
      log.info({ ...outcome, archived }, "delete batch complete");
      this.lastOutcome = outcome;
      return outcome;
    }

    // 1. Build prompt
    const prompt = await buildIngestionPrompt({
      config: this.opts.config,
      files: batch.paths,
    });

    // 1a. Hash source files NOW (M-PIPE-1). Computing source_hashes at
    // provenance-append time opens a race window: a concurrent manual edit
    // to a raw/ file between now and the chain append would drift the
    // recorded hash from the state the agent actually consumed. We hash
    // as soon as we know the batch paths and hold the result through to
    // provenance append.
    const sourceFiles = [...batch.paths];
    const sourceHashes: string[] = [];
    for (const p of sourceFiles) {
      const h = await sha256File(p);
      sourceHashes.push(h ?? "missing");
    }

    // 2. Pre-flight budget check. CLI mode is subscription-covered — skip
    // the budget check entirely. API mode estimates 12k input + 4k output
    // worst-case until we know the real cost.
    const preflight =
      runtimeMode === "cli" ? 0 : this.opts.modelRouter.computeCost(model, 12_000, 4_000);
    if (runtimeMode !== "cli" && this.opts.costTracker.wouldExceedDaily(preflight)) {
      const outcome: IngestionOutcome = {
        batchId: batch.id,
        skipped: true,
        skipReason: "daily budget exceeded",
        pagesWritten: 0,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
      log.warn({ batchId: batch.id }, "skipping batch — daily budget exceeded");
      this.lastOutcome = outcome;
      return outcome;
    }

    // 3. Invoke the agent. The agent writes wiki files directly via the SDK
    // (API mode) or via the spawned `claude` CLI (CLI mode). The dispatcher
    // is hidden behind invokeIngestionAgent.
    let invokeResult;
    try {
      invokeResult = await invokeIngestionAgent({
        cwd: this.opts.config.wiki_root,
        systemPrompt: prompt.system,
        userPrompt: prompt.text,
        model,
        maxTurns: this.opts.config.ingestion.max_turns,
        resumeSessionId:
          this.opts.config.ingestion.resume_session && this.resumeSessionId
            ? this.resumeSessionId
            : undefined,
        runtimeMode,
        cliConfig:
          runtimeMode === "cli"
            ? {
                cliPath: this.opts.config.execution.cli_path,
                cliModel: this.opts.config.execution.cli_model,
              }
            : undefined,
      });
    } catch (err) {
      log.error({ err, batchId: batch.id }, "ingestion agent invocation failed");
      if (this.opts.deadLetter) {
        await this.opts.deadLetter.record(batch, err, "add");
      }
      const outcome: IngestionOutcome = {
        batchId: batch.id,
        skipped: true,
        skipReason: `agent error: ${errMsg(err)}`,
        pagesWritten: 0,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    if (invokeResult.sessionId) this.resumeSessionId = invokeResult.sessionId;

    // 4. Reconcile written pages
    const { pages: newPages, skipped: skippedWrites } = await reconcileWrittenPages(
      this.opts.store,
      invokeResult.writtenPaths,
      { staging: this.opts.config.ingestion.staging },
    );
    if (skippedWrites.length > 0) {
      log.warn({ skipped: skippedWrites, batchId: batch.id }, "some written paths skipped");
    }

    // Guard: if the agent produced zero pages, skip all downstream work.
    if (newPages.length === 0 && skippedWrites.length === 0) {
      log.warn({ batchId: batch.id }, "agent produced zero pages — marking batch as skipped");
      const outcome: IngestionOutcome = {
        batchId: batch.id,
        skipped: true,
        skipReason: "agent produced no wiki pages",
        pagesWritten: 0,
        costUsd: invokeResult.totalCostUsd,
        gitSha: null,
        durationMs: Date.now() - started,
      };
      this.lastOutcome = outcome;
      return outcome;
    }

    // 5. Repair bidirectional links across the whole wiki (cheap: in-memory)
    const allPages = await loadAllPages(this.opts.store);
    const mutated = repairBidirectionalLinks(this.opts.store, allPages);
    for (const p of mutated) {
      await this.opts.store.writePage(p);
    }

    // 6. Rebuild index + search
    const finalPages = mutated.length > 0 ? await loadAllPages(this.opts.store) : allPages;
    await this.opts.indexManager.rebuild(finalPages);
    this.opts.search.rebuild(finalPages);

    // 6a. Hash every written wiki file NOW (M-PIPE-1). Computing these
    // lazily at provenance-append time opens a race window with concurrent
    // compounding passes or manual edits between the last write and the
    // append. Capture the committed state here, while no other writer can
    // touch these paths, and thread the precomputed hashes through to the
    // provenance record.
    const writtenAbsPaths = [
      ...newPages.map((p) => p.path),
      ...mutated.map((p) => p.path),
      `${this.opts.store.wikiDir}/index.md`,
    ];
    const uniqueWrittenAbs = [...new Set(writtenAbsPaths)];
    const wikiFileHashesByAbs = await sha256Files(uniqueWrittenAbs);
    const wikiRoot = this.opts.config.wiki_root;
    const wikiFileHashes: Record<string, string> = {};
    for (const abs of uniqueWrittenAbs) {
      const h = wikiFileHashesByAbs[abs];
      if (h) wikiFileHashes[relative(wikiRoot, abs) || abs] = h;
    }

    // 7. Log cost
    this.opts.costTracker.logUsage({
      operation: "ingest",
      model,
      costUsd: invokeResult.totalCostUsd,
      inputTokens: invokeResult.inputTokens,
      outputTokens: invokeResult.outputTokens,
      batchId: batch.id,
    });

    // 8. Append provenance record (before commit so the chain file is
    // included in the same git commit as the wiki pages it describes).
    // Source and wiki-file hashes were captured eagerly at steps 1a / 6a
    // to close the M-PIPE-1 race window.
    if (this.opts.provenance) {
      try {
        await this.recordProvenance({
          batch,
          model,
          promptText: `${prompt.system}\n\n---\n\n${prompt.text}`,
          responseText: invokeResult.finalText,
          sourceFiles,
          sourceHashes,
          wikiFileHashes,
          costUsd: invokeResult.totalCostUsd,
          inputTokens: invokeResult.inputTokens,
          outputTokens: invokeResult.outputTokens,
          durationMs: Date.now() - started,
        });
      } catch (err) {
        log.error({ err, batchId: batch.id }, "failed to append provenance record");
        // Continue — provenance failure should not roll back ingestion.
      }
    }

    // 9. Commit
    const changedPaths = [
      ...newPages.map((p) => p.path),
      ...mutated.map((p) => p.path),
      // Always include the generated index and provenance chain file
      // (even if it didn't change; git-add is idempotent).
      `${this.opts.store.wikiDir}/index.md`,
      ...(this.opts.provenance ? [this.opts.provenance.path] : []),
    ];
    const uniquePaths = [...new Set(changedPaths)];
    const commit = await commitWikiChanges({
      wikiRoot: this.opts.config.wiki_root,
      paths: uniquePaths,
      operationId: batch.id,
      operation: "ingest",
      metadata: {
        files: batch.paths.length,
        pages_written: newPages.length,
        cost_usd: invokeResult.totalCostUsd.toFixed(6),
        model,
      },
    });

    // 10. Process any deletions in this same batch. Deletes run AFTER
    // adds so an add+delete window (e.g. rename) still produces a
    // coherent final state. See Feature 2: deletion handling.
    if (batch.deletedPaths.length > 0) {
      await this.archiveDeletedSources(batch.deletedPaths, batch);
    }

    const outcome: IngestionOutcome = {
      batchId: batch.id,
      skipped: false,
      pagesWritten: newPages.length,
      costUsd: invokeResult.totalCostUsd,
      gitSha: commit.sha,
      durationMs: Date.now() - started,
    };
    log.info(outcome, "batch complete");
    this.lastOutcome = outcome;
    return outcome;
  }

  /**
   * Archive wiki pages whose source files were deleted. For every deleted
   * raw file we consult the provenance chain for records that touched it,
   * collect the union of wiki pages those records wrote, mark each page
   * with frontmatter `status: orphaned` / `orphaned_at` / `orphaned_source`,
   * rewrite it, and append a single `"archive"` provenance record
   * summarising the operation. Wiki files are NEVER deleted — orphaning
   * is reversible and preserves history.
   *
   * Returns the number of wiki pages that were marked orphaned by this
   * call. Deletions with no matching provenance records (e.g. a raw file
   * deleted before any batch consumed it) still produce a lightweight
   * archive record so the chain shows the deletion was observed.
   */
  private async archiveDeletedSources(
    deletedAbsPaths: string[],
    batch: WatcherBatch,
  ): Promise<number> {
    const log = getLogger("ingestion");
    const wikiRoot = this.opts.config.wiki_root;
    const toRel = (abs: string): string => relative(wikiRoot, abs) || abs;

    // 1. Collect the affected wiki pages via provenance lookup.
    const affected = new Map<string, Set<string>>(); // abs wiki path → rel source paths
    if (this.opts.provenance) {
      for (const deleted of deletedAbsPaths) {
        const relDeleted = toRel(deleted);
        // recordsFor matches both source_files and wiki_files_written.
        // We only want records whose SOURCE was this file.
        const records = await this.opts.provenance.recordsFor(relDeleted);
        for (const rec of records) {
          if (!rec.source_files.includes(relDeleted)) continue;
          for (const relWikiPath of rec.wiki_files_written) {
            const absWiki = resolve(wikiRoot, relWikiPath);
            if (!affected.has(absWiki)) affected.set(absWiki, new Set());
            affected.get(absWiki)!.add(relDeleted);
          }
        }
      }
    }

    // 2. Mark each affected wiki page as orphaned.
    const nowIso = new Date().toISOString();
    const rewrittenPages: string[] = [];
    for (const [absWiki, sources] of affected) {
      const page = await this.opts.store.readPage(absWiki);
      if (!page) continue; // Page was already deleted or never existed.
      const existingSources = new Set(page.frontmatter.orphaned_source ?? []);
      for (const s of sources) existingSources.add(s);
      page.frontmatter.status = "orphaned";
      if (!page.frontmatter.orphaned_at) {
        page.frontmatter.orphaned_at = nowIso;
      }
      page.frontmatter.orphaned_source = [...existingSources].sort();
      page.frontmatter.updated = nowIso.slice(0, 10);
      await this.opts.store.writePage(page);
      rewrittenPages.push(absWiki);
    }

    // 3. Rebuild index + search so orphaned status is reflected everywhere.
    if (rewrittenPages.length > 0) {
      const allPages = await loadAllPages(this.opts.store);
      await this.opts.indexManager.rebuild(allPages);
      this.opts.search.rebuild(allPages);
    }

    // 4. Append a provenance "archive" record. Even when no pages were
    // rewritten (orphan from a never-ingested source) we still log the
    // archive so the chain records the deletion event.
    if (this.opts.provenance) {
      try {
        const hashesByAbs = await sha256Files(rewrittenPages);
        const wikiFileHashes: Record<string, string> = {};
        for (const abs of rewrittenPages) {
          const h = hashesByAbs[abs];
          if (h) wikiFileHashes[toRel(abs)] = h;
        }
        const deletedRel = deletedAbsPaths.map(toRel);
        await this.opts.provenance.append({
          type: "archive",
          source_files: deletedRel,
          // Sources are gone — their prior hashes live in earlier records.
          source_hashes: deletedRel.map(() => "deleted"),
          prompt_hash: sha256Hex("archive"),
          model_id: "none",
          response_hash: sha256Hex("archive"),
          wiki_files_written: Object.keys(wikiFileHashes),
          wiki_file_hashes_after: wikiFileHashes,
          metadata: {
            batch_id: batch.id,
            deleted_sources: deletedRel.length,
            orphaned_pages: rewrittenPages.length,
          },
        });
      } catch (err) {
        log.error({ err, batchId: batch.id }, "failed to append archive provenance record");
      }
    }

    // 5. Commit the archive as a single git commit so the deletion shows
    // up in history alongside the index refresh.
    try {
      const paths = [
        ...rewrittenPages,
        `${this.opts.store.wikiDir}/index.md`,
        ...(this.opts.provenance ? [this.opts.provenance.path] : []),
      ];
      await commitWikiChanges({
        wikiRoot: this.opts.config.wiki_root,
        paths: [...new Set(paths)],
        operationId: batch.id,
        operation: "archive",
        metadata: {
          deleted: deletedAbsPaths.length,
          orphaned_pages: rewrittenPages.length,
        },
      });
    } catch (err) {
      log.warn({ err, batchId: batch.id }, "archive commit failed (non-fatal)");
    }

    log.info(
      {
        batchId: batch.id,
        deleted: deletedAbsPaths.length,
        orphanedPages: rewrittenPages.length,
      },
      "archive complete",
    );
    return rewrittenPages.length;
  }

  /**
   * Append a provenance record describing a completed ingestion batch.
   * Source and wiki-file hashes are precomputed by the caller at the
   * point of read/write (M-PIPE-1) and threaded in here. Paths are stored
   * as wiki-relative strings so the chain is portable across machines
   * with different wiki_root values.
   */
  private async recordProvenance(args: {
    batch: WatcherBatch;
    model: string;
    promptText: string;
    responseText: string;
    sourceFiles: string[];
    sourceHashes: string[];
    wikiFileHashes: Record<string, string>;
    costUsd: number;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
  }): Promise<void> {
    if (!this.opts.provenance) return;
    const wikiRoot = this.opts.config.wiki_root;
    // Use path.relative for portable, platform-correct relative paths
    // (L-CODE-1). The previous substring-replace approach broke on
    // Windows separators and on paths where `wikiRoot` appeared mid-path.
    const toRel = (abs: string): string => relative(wikiRoot, abs) || abs;

    await this.opts.provenance.append({
      type: "ingest",
      source_files: args.sourceFiles.map(toRel),
      source_hashes: args.sourceHashes,
      prompt_hash: sha256Hex(args.promptText),
      model_id: args.model,
      response_hash: sha256Hex(args.responseText),
      wiki_files_written: Object.keys(args.wikiFileHashes),
      wiki_file_hashes_after: args.wikiFileHashes,
      metadata: {
        batch_id: args.batch.id,
        cost_usd: Number(args.costUsd.toFixed(6)),
        input_tokens: args.inputTokens,
        output_tokens: args.outputTokens,
        duration_ms: args.durationMs,
      },
    });
  }
}
