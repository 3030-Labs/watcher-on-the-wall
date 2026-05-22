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
import { errMsg } from "../utils/errors.js";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig, WikiPage } from "../utils/types.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import { loadAllPages } from "../ingestion/wiki-writer.js";
import { newPage } from "../wiki/page.js";
import type { WikiStore } from "../wiki/store.js";
import type { IndexManager } from "../wiki/index-manager.js";
import type { WikiSearch } from "../wiki/search.js";
import { repairBidirectionalLinks } from "../wiki/cross-reference.js";
import { commitWikiChanges } from "../ingestion/git-committer.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256File, sha256Files, sha256Hex } from "../provenance/hash.js";

/** Per-source body cap in bytes (clamps prompt size). */
const MAX_SOURCE_BODY_BYTES = 16 * 1024;
/** Max tokens for the synthesis body response. */
const SYNTHESIS_MAX_TOKENS = 8192;

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
          reason: `error: ${errMsg(err)}`,
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
   * Single-pass synthesis for a cluster. Pre-assembles full source page
   * bodies into the prompt; the model returns markdown body content only;
   * the daemon assembles frontmatter from the cluster metadata and writes
   * the synthesis page atomically via WikiStore.
   *
   * Frontmatter shape (daemon-assembled, not model-chosen):
   *   - title       = cluster.tag (verbatim)
   *   - category    = "synthesis"
   *   - sources     = wiki-relative paths of every clustered page
   *   - tags        = [cluster.tag]
   *   - confidence  = "medium"
   *   - created/updated = today
   *
   * Source page bodies are clamped to MAX_SOURCE_BODY_BYTES (16KB) each.
   * Pages exceeding the cap get a `_[truncated]_` marker. With min-cluster
   * size 3 and typical pages 2-5KB, prompts stay well within model context.
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
    const sourceRelPaths = cluster.pages.map((p) => relative(this.opts.config.wiki_root, p.path));

    const systemPrompt = [
      "You are the watcher-on-the-wall compounding agent.",
      "You write synthesis pages that connect related wiki pages into higher-level insights.",
      "Rules:",
      "  1. Use ONLY the source page contents provided in the user message. Do not invent facts.",
      "  2. Return markdown body content ONLY. Do NOT include YAML frontmatter — the daemon writes it.",
      "  3. Cite each source inline using [[wiki-link]] syntax or [Title](path) markdown links.",
      "  4. If the sources don't support a claim, omit it.",
      "  5. Aim for a clear synthesis that identifies connections and higher-level themes, not a summary of each source in turn.",
    ].join("\n");

    // Pre-assemble source page bodies. The model sees the complete content
    // it needs to synthesize from; no in-call Read tool required.
    const sourceSections = cluster.pages.map((p) => {
      const relPath = relative(this.opts.config.wiki_root, p.path);
      const truncated = p.body.length > MAX_SOURCE_BODY_BYTES;
      const body = truncated
        ? `${p.body.slice(0, MAX_SOURCE_BODY_BYTES)}\n\n_[truncated]_`
        : p.body;
      return [
        `## ${p.frontmatter.title}`,
        `path: ${relPath}`,
        `category: ${p.frontmatter.category}`,
        "",
        body,
      ].join("\n");
    });

    const userPrompt = [
      `# Synthesis request: tag "${cluster.tag}"`,
      "",
      `## Source pages (${cluster.pages.length})`,
      "",
      sourceSections.join("\n\n---\n\n"),
      "",
      "---",
      "Write a synthesis that connects these sources into higher-level insights.",
      "Output markdown body content ONLY — no YAML frontmatter, no surrounding code fences.",
      "Cite every source inline.",
    ].join("\n");

    log.info(
      { tag: cluster.tag, pages: cluster.pages.length, outRel, runtimeMode },
      "synthesizing cluster",
    );

    const result = await runtimeAwareComplete(userPrompt, {
      systemPrompt,
      model,
      maxTokens: SYNTHESIS_MAX_TOKENS,
      config: this.opts.config,
      runtimeMode,
    });

    const bodyText = stripFrontmatterIfPresent(result.text).trim();
    if (!bodyText) {
      log.warn({ tag: cluster.tag }, "model returned empty synthesis body");
      return { costUsd: result.costUsd, writtenPath: null };
    }

    // Daemon assembles frontmatter from cluster metadata and writes the
    // synthesis page atomically. Title uses the cluster tag verbatim.
    const synthesisPage = newPage(outAbs, cluster.tag, "synthesis", bodyText, {
      sources: sourceRelPaths,
      tags: [cluster.tag],
      confidence: "medium",
    });
    try {
      await this.opts.store.writePage(synthesisPage);
    } catch (err) {
      log.error({ err, tag: cluster.tag, outAbs }, "failed to write synthesis page");
      return { costUsd: result.costUsd, writtenPath: null };
    }
    return { costUsd: result.costUsd, writtenPath: outAbs };
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

/**
 * Defensive frontmatter stripper. The prompt instructs the model NOT to
 * emit YAML frontmatter, but models sometimes ignore that. If the response
 * starts with `---\n...\n---` we strip it so the daemon-assembled
 * frontmatter is the only one present. Returns the body without
 * frontmatter; returns the input unchanged if no frontmatter detected.
 */
function stripFrontmatterIfPresent(text: string): string {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("---")) return text;
  const afterFirst = trimmed.slice(3);
  // Frontmatter must end with a newline before closing ---
  const closingMatch = afterFirst.match(/\n---\s*\n/);
  if (!closingMatch || closingMatch.index === undefined) return text;
  return afterFirst.slice(closingMatch.index + closingMatch[0].length);
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
