/**
 * Compounding engine. Periodically (or on demand) the daemon can run a
 * synthesis pass: look at the accumulated wiki, find clusters of related
 * pages, and ask the agent to write higher-level synthesis pages that
 * weave them together.
 *
 * Design philosophy:
 *   - Never rewrite existing pages — synthesis is always additive and
 *     lands under wiki/syntheses/.
 *   - Cluster detection is a cheap structural heuristic (shared tags and
 *     frontmatter `related` edges). The expensive LLM work only runs on
 *     the clusters that clear the minimum-size threshold.
 *   - Budget-gated via CostTracker like the ingestion queue.
 *   - Every synthesis is recorded in the provenance chain as an operation
 *     of type "compound".
 */
import { join, relative } from "node:path";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig, WikiPage } from "../utils/types.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import { invokeIngestionAgent } from "../ingestion/llm-invoker.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import { loadAllPages } from "../ingestion/wiki-writer.js";
import type { WikiStore } from "../wiki/store.js";
import type { IndexManager } from "../wiki/index-manager.js";
import type { WikiSearch } from "../wiki/search.js";
import { repairBidirectionalLinks } from "../wiki/cross-reference.js";
import { commitWikiChanges } from "../ingestion/git-committer.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256File, sha256Files, sha256Hex } from "../provenance/hash.js";

export interface CompoundingEngineOptions {
  config: WotwConfig;
  store: WikiStore;
  indexManager: IndexManager;
  search: WikiSearch;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  provenance?: ProvenanceChain | null;
  /**
   * Resolved runtime mode. Defaults to "api" so legacy callers and test rigs
   * keep working without change. When set to "cli" the engine spawns the
   * `claude` binary for every cluster and logs cost=0 (subscription-covered).
   */
  runtimeMode?: RuntimeMode;
}

export interface CompoundingOutcome {
  skipped: boolean;
  skipReason?: string;
  clusters: ClusterSummary[];
  pagesWritten: number;
  costUsd: number;
  gitSha: string | null;
  durationMs: number;
}

export interface ClusterSummary {
  tag: string;
  pages: string[];
  synthesisPath: string | null;
  skipped: boolean;
  reason?: string;
}

/** In-memory representation of a candidate synthesis cluster. */
interface Cluster {
  tag: string;
  pages: WikiPage[];
}

export class CompoundingEngine {
  private readonly opts: CompoundingEngineOptions;

  constructor(opts: CompoundingEngineOptions) {
    this.opts = opts;
  }

  /**
   * Run a single compounding pass. Returns the list of clusters that were
   * considered and the synthesis pages that were written (if any).
   */
  async synthesize(): Promise<CompoundingOutcome> {
    const log = getLogger("compounding");
    const started = Date.now();
    const runtimeMode: RuntimeMode = this.opts.runtimeMode ?? "api";

    if (!this.opts.config.compounding.enabled) {
      return {
        skipped: true,
        skipReason: "compounding disabled in config",
        clusters: [],
        pagesWritten: 0,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
    }

    // Global budget pre-flight — use the ingest budget as a ceiling since
    // compounding is qualitatively similar to ingestion (agent writes pages).
    // CLI mode is subscription-covered, so the model resolves to cli_model
    // and the budget check is skipped.
    const model =
      runtimeMode === "cli"
        ? this.opts.config.execution.cli_model
        : this.opts.modelRouter.modelFor("compound_eval");
    const estimate =
      runtimeMode === "cli" ? 0 : this.opts.modelRouter.computeCost(model, 20_000, 6_000);
    if (runtimeMode !== "cli" && this.opts.costTracker.wouldExceedDaily(estimate)) {
      return {
        skipped: true,
        skipReason: "daily budget exceeded",
        clusters: [],
        pagesWritten: 0,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
    }

    const pages = await loadAllPages(this.opts.store);
    if (pages.length < this.opts.config.compounding.min_source_pages) {
      return {
        skipped: true,
        skipReason: `wiki has ${pages.length} pages, minimum is ${this.opts.config.compounding.min_source_pages}`,
        clusters: [],
        pagesWritten: 0,
        costUsd: 0,
        gitSha: null,
        durationMs: Date.now() - started,
      };
    }

    const clusters = this.findClusters(pages);
    log.info({ clusters: clusters.length }, "candidate clusters");

    const outcomes: ClusterSummary[] = [];
    const writtenAbsPaths: string[] = [];
    let totalCostUsd = 0;

    for (const cluster of clusters) {
      // Skip clusters that already have a synthesis covering all their pages.
      if (this.hasExistingSynthesis(cluster, pages)) {
        outcomes.push({
          tag: cluster.tag,
          pages: cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path)),
          synthesisPath: null,
          skipped: true,
          reason: "existing synthesis covers this cluster",
        });
        continue;
      }

      // Per-cluster budget check so one expensive cluster doesn't torch the day.
      // (Skipped in CLI mode — no per-call billing.)
      if (runtimeMode !== "cli" && this.opts.costTracker.wouldExceedDaily(estimate)) {
        outcomes.push({
          tag: cluster.tag,
          pages: cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path)),
          synthesisPath: null,
          skipped: true,
          reason: "budget exceeded mid-run",
        });
        continue;
      }

      try {
        const result = await this.synthesizeCluster(cluster, model, runtimeMode);
        if (result) {
          totalCostUsd += result.costUsd;
          if (result.writtenPath) writtenAbsPaths.push(result.writtenPath);
          outcomes.push({
            tag: cluster.tag,
            pages: cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path)),
            synthesisPath: result.writtenPath
              ? relative(this.opts.config.wiki_root, result.writtenPath)
              : null,
            skipped: result.writtenPath === null,
            reason: result.writtenPath === null ? "agent wrote no synthesis file" : undefined,
          });

          this.opts.costTracker.logUsage({
            operation: "compound",
            model,
            costUsd: result.costUsd,
          });
        }
      } catch (err) {
        log.error({ err, tag: cluster.tag }, "cluster synthesis failed");
        outcomes.push({
          tag: cluster.tag,
          pages: cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path)),
          synthesisPath: null,
          skipped: true,
          reason: `error: ${(err as Error).message}`,
        });
      }
    }

    // If nothing was written we're done.
    if (writtenAbsPaths.length === 0) {
      return {
        skipped: false,
        clusters: outcomes,
        pagesWritten: 0,
        costUsd: totalCostUsd,
        gitSha: null,
        durationMs: Date.now() - started,
      };
    }

    // Post-write: rebuild links, search, and index; commit.
    const allPages = await loadAllPages(this.opts.store);
    const mutated = repairBidirectionalLinks(this.opts.store, allPages);
    for (const p of mutated) await this.opts.store.writePage(p);
    const finalPages = mutated.length > 0 ? await loadAllPages(this.opts.store) : allPages;
    await this.opts.indexManager.rebuild(finalPages);
    this.opts.search.rebuild(finalPages);

    // Provenance record.
    if (this.opts.provenance) {
      try {
        await this.recordProvenance({
          model,
          clusters: outcomes,
          writtenAbsPaths,
          costUsd: totalCostUsd,
        });
      } catch (err) {
        log.error({ err }, "failed to append compound provenance");
      }
    }

    // Git commit all the things.
    const commitPaths = [
      ...writtenAbsPaths,
      ...mutated.map((p) => p.path),
      `${this.opts.store.wikiDir}/index.md`,
      ...(this.opts.provenance ? [this.opts.provenance.path] : []),
    ];
    const commit = await commitWikiChanges({
      wikiRoot: this.opts.config.wiki_root,
      paths: [...new Set(commitPaths)],
      operationId: `compound-${Date.now()}`,
      operation: "compound",
      metadata: {
        clusters: outcomes.filter((o) => !o.skipped).length,
        pages_written: writtenAbsPaths.length,
        cost_usd: totalCostUsd.toFixed(6),
        model,
      },
    });

    return {
      skipped: false,
      clusters: outcomes,
      pagesWritten: writtenAbsPaths.length,
      costUsd: totalCostUsd,
      gitSha: commit.sha,
      durationMs: Date.now() - started,
    };
  }

  /**
   * Find candidate clusters. Current heuristic: group every page by each of
   * its tags; a cluster is a tag with >= min_source_pages pages. We filter
   * out 'source' pages since the interesting synthesis is over concepts
   * and entities, not raw inputs.
   */
  private findClusters(pages: WikiPage[]): Cluster[] {
    const minSize = this.opts.config.compounding.min_source_pages;
    const byTag = new Map<string, WikiPage[]>();
    for (const p of pages) {
      if (p.frontmatter.category === "source") continue;
      if (p.frontmatter.category === "synthesis") continue;
      for (const tag of p.frontmatter.tags ?? []) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag)!.push(p);
      }
    }
    const clusters: Cluster[] = [];
    for (const [tag, tagPages] of byTag) {
      if (tagPages.length >= minSize) {
        clusters.push({ tag, pages: tagPages });
      }
    }
    // Deterministic ordering: largest clusters first, then alpha by tag.
    clusters.sort((a, b) => {
      if (b.pages.length !== a.pages.length) return b.pages.length - a.pages.length;
      return a.tag.localeCompare(b.tag);
    });
    return clusters;
  }

  /**
   * Check whether a synthesis page already exists that covers a superset
   * of this cluster. If yes, we skip to avoid duplicate work.
   */
  private hasExistingSynthesis(cluster: Cluster, pages: WikiPage[]): boolean {
    const clusterPaths = new Set(
      cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path)),
    );
    for (const p of pages) {
      if (p.frontmatter.category !== "synthesis") continue;
      const sources = new Set(p.frontmatter.sources ?? []);
      // An existing synthesis covers the cluster if it lists every clustered
      // page as one of its sources.
      let covers = true;
      for (const c of clusterPaths) {
        if (!sources.has(c)) {
          covers = false;
          break;
        }
      }
      if (covers) return true;
    }
    return false;
  }

  /**
   * Invoke the agent for a single cluster. The agent is told the cluster's
   * tag and the list of pages and asked to write a single synthesis page
   * under wiki/syntheses/. We use a narrow tool whitelist (Read, Glob, Write).
   * Dispatches to the CLI binary or the SDK depending on `runtimeMode`.
   */
  private async synthesizeCluster(
    cluster: Cluster,
    model: string,
    runtimeMode: RuntimeMode,
  ): Promise<{ costUsd: number; writtenPath: string | null } | null> {
    const log = getLogger("compounding");
    const slug = slugifyTag(cluster.tag);
    const outAbs = join(this.opts.store.categoryDir("synthesis"), `${slug}.md`);
    const outRel = relative(this.opts.config.wiki_root, outAbs);

    const systemPrompt = [
      "You are the watcher-on-the-wall compounding agent.",
      "You write synthesis pages that connect related wiki pages into higher-level insights.",
      "Rules:",
      "  1. Read every source page listed before writing.",
      "  2. Write EXACTLY ONE file — the synthesis page — using the Write tool.",
      "  3. The synthesis must include valid frontmatter (title, category: synthesis, created, updated, sources, related, tags, confidence).",
      "  4. The `sources` array must contain the wiki-relative paths of every page in the cluster.",
      "  5. Use [[wiki-link]] syntax or markdown links to reference source pages inline.",
      "  6. Do not invent facts. If the sources don't support a claim, omit it.",
      "  7. Do not edit or overwrite any existing wiki page.",
    ].join("\n");

    const sourceList = cluster.pages
      .map((p) => `- ${relative(this.opts.config.wiki_root, p.path)} — "${p.frontmatter.title}"`)
      .join("\n");

    const userPrompt = [
      `# Synthesis request: tag "${cluster.tag}"`,
      "",
      `Write a synthesis page at: \`${outRel}\``,
      "",
      `## Source pages (${cluster.pages.length})`,
      "",
      sourceList,
      "",
      "Read each source page, identify the connections and higher-level themes across them,",
      "and write a single synthesis page that weaves them together. Use inline citations to",
      "every source.",
    ].join("\n");

    log.info(
      { tag: cluster.tag, pages: cluster.pages.length, outRel, runtimeMode },
      "synthesizing cluster",
    );

    const result = await invokeIngestionAgent({
      cwd: this.opts.config.wiki_root,
      systemPrompt,
      userPrompt,
      model,
      maxTurns: 20,
      allowedTools: ["Read", "Glob", "Grep", "Write"],
      runtimeMode,
      cliConfig:
        runtimeMode === "cli"
          ? {
              cliPath: this.opts.config.execution.cli_path,
              cliModel: this.opts.config.execution.cli_model,
            }
          : undefined,
    });

    // The agent should have produced outAbs. If it wrote a different path
    // instead, we still accept it but log a warning.
    let writtenPath: string | null = null;
    for (const p of result.writtenPaths) {
      if (p === outAbs || p.endsWith(`${slug}.md`)) {
        writtenPath = p;
        break;
      }
    }
    if (writtenPath === null && result.writtenPaths.length > 0) {
      writtenPath = result.writtenPaths[0] ?? null;
      log.warn({ wrote: result.writtenPaths, expected: outAbs }, "agent wrote unexpected path");
    }
    if (writtenPath === null) {
      log.warn({ tag: cluster.tag }, "agent did not write a synthesis file");
    }
    return { costUsd: result.totalCostUsd, writtenPath };
  }

  /** Append a provenance record describing this synthesis pass. */
  private async recordProvenance(args: {
    model: string;
    clusters: ClusterSummary[];
    writtenAbsPaths: string[];
    costUsd: number;
  }): Promise<void> {
    if (!this.opts.provenance) return;
    const wikiRoot = this.opts.config.wiki_root;
    const toRel = (abs: string): string => relative(wikiRoot, abs) || abs;

    // source_files: the union of every clustered source, wiki-relative.
    const sourceSet = new Set<string>();
    for (const c of args.clusters) {
      for (const p of c.pages) sourceSet.add(p);
    }
    const sourceFiles = [...sourceSet].sort();

    // source_hashes: hash the current on-disk content of each source (as
    // the synthesis was derived from this snapshot).
    const sourceHashes: string[] = [];
    for (const rel of sourceFiles) {
      const abs = join(wikiRoot, rel);
      const h = await sha256File(abs);
      sourceHashes.push(h ?? "missing");
    }

    // wiki_files_written: the synthesis pages produced.
    const hashesByAbs = await sha256Files(args.writtenAbsPaths);
    const wikiFileHashes: Record<string, string> = {};
    for (const abs of args.writtenAbsPaths) {
      const h = hashesByAbs[abs];
      if (h) wikiFileHashes[toRel(abs)] = h;
    }

    await this.opts.provenance.append({
      type: "compound",
      source_files: sourceFiles,
      source_hashes: sourceHashes,
      prompt_hash: sha256Hex(args.clusters.map((c) => `${c.tag}:${c.pages.join(",")}`).join("|")),
      model_id: args.model,
      response_hash: sha256Hex(Object.values(wikiFileHashes).join("|")),
      wiki_files_written: Object.keys(wikiFileHashes),
      wiki_file_hashes_after: wikiFileHashes,
      metadata: {
        cluster_count: args.clusters.length,
        pages_written: args.writtenAbsPaths.length,
        cost_usd: Number(args.costUsd.toFixed(6)),
      },
    });
  }
}

/** Convert a free-form tag into a safe filename slug. */
function slugifyTag(tag: string): string {
  return (
    tag
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "cluster"
  );
}
