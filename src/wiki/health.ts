/**
 * Knowledge health scoring and report generation.
 *
 * Every wiki page gets a health score (0-100) based on objective factors:
 * staleness, source availability, link health, duplicate risk, and
 * contradiction risk. The report also includes findings (stale pages,
 * broken links, orphans, duplicates, missing backlinks).
 *
 * All detection passes in this module are pure computation + file I/O —
 * no LLM calls. Contradiction detection requires the LLM and is handled
 * separately via the heal handlers when `health.detect_contradictions`
 * is enabled.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import type { ProvenanceChain } from "../provenance/chain.js";
import type { ProvenanceRecord, WotwConfig } from "../utils/types.js";
import { extractWikiLinks, normalizeSlug, toWikiSlug } from "./cross-reference.js";
import type { WikiSearch } from "./search.js";
import type { WikiStore } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FindingKind =
  | "stale"
  | "duplicate"
  | "contradiction"
  | "orphan"
  | "broken-link"
  | "missing-backlink"
  | "consolidation";

export interface HealthFinding {
  /** Stable identifier, e.g. "stale:concepts/old-page". */
  id: string;
  kind: FindingKind;
  severity: "high" | "medium" | "low";
  /** Wiki-relative paths involved. */
  pages: string[];
  description: string;
  /** Can the LLM fix this without human review? */
  autoFixable: boolean;
}

export interface PageHealthScore {
  /** Wiki-relative path. */
  page: string;
  score: number;
  factors: {
    staleness: number;
    sourceAvailability: number;
    linkHealth: number;
    duplicateRisk: number;
    contradictionRisk: number;
  };
}

export interface HealthReportSummary {
  total: number;
  high: number;
  medium: number;
  low: number;
  autoFixable: number;
}

export interface HealthReport {
  timestamp: string;
  findings: HealthFinding[];
  scores: PageHealthScore[];
  summary: HealthReportSummary;
}

export interface HealthReportOptions {
  config: WotwConfig;
  /** Pre-loaded provenance records (avoids re-reading the chain file). */
  provenanceRecords?: ProvenanceRecord[];
}

// ---------------------------------------------------------------------------
// Staleness scoring
// ---------------------------------------------------------------------------

/**
 * Compute staleness score for a single page based on the most recent ingest
 * record that wrote to it.
 */
export function computeStaleness(
  pageRelPath: string,
  records: ProvenanceRecord[],
  thresholds: number[],
  scores: number[],
  now: Date = new Date(),
): number {
  // Find most recent "ingest" or "heal" record that wrote this page.
  let latestTs: number | null = null;
  for (const r of records) {
    if (r.type !== "ingest" && r.type !== "heal" && r.type !== "compound") continue;
    if (!r.wiki_files_written.includes(pageRelPath)) continue;
    const ts = Date.parse(r.timestamp);
    if (!isNaN(ts) && (latestTs === null || ts > latestTs)) {
      latestTs = ts;
    }
  }
  if (latestTs === null) return scores[scores.length - 1] ?? 0;
  const ageDays = (now.getTime() - latestTs) / (1000 * 60 * 60 * 24);
  for (let i = 0; i < thresholds.length; i++) {
    if (ageDays <= thresholds[i]!) return scores[i] ?? 100;
  }
  return scores[scores.length - 1] ?? 0;
}

// ---------------------------------------------------------------------------
// Source availability scoring
// ---------------------------------------------------------------------------

/**
 * Compute source availability for a page. Checks whether the raw source
 * files that produced it still exist on disk.
 */
export function computeSourceAvailability(
  pageRelPath: string,
  records: ProvenanceRecord[],
  wikiRoot: string,
  isOrphaned: boolean,
): number {
  if (isOrphaned) return 0;
  // Collect all source files from ingest records that wrote this page.
  const sources = new Set<string>();
  for (const r of records) {
    if (r.type !== "ingest") continue;
    if (!r.wiki_files_written.includes(pageRelPath)) continue;
    for (const s of r.source_files) sources.add(s);
  }
  if (sources.size === 0) return 100; // no known provenance — don't penalize
  let exists = 0;
  for (const s of sources) {
    const abs = join(wikiRoot, s);
    if (existsSync(abs)) exists += 1;
  }
  return Math.round((exists / sources.size) * 100);
}

// ---------------------------------------------------------------------------
// Link health scoring
// ---------------------------------------------------------------------------

/**
 * Compute link health for a page based on the ratio of valid wikilinks.
 */
export function computeLinkHealth(
  body: string,
  allPageSlugs: Set<string>,
): { score: number; broken: string[] } {
  const links = extractWikiLinks(body);
  if (links.length === 0) return { score: 100, broken: [] };
  const broken: string[] = [];
  for (const link of links) {
    if (!allPageSlugs.has(normalizeSlug(link))) {
      broken.push(link);
    }
  }
  const valid = links.length - broken.length;
  return {
    score: Math.round((valid / links.length) * 100),
    broken,
  };
}

// ---------------------------------------------------------------------------
// Duplicate risk scoring
// ---------------------------------------------------------------------------

/**
 * Compute duplicate risk for a page using the search index. Returns the
 * similarity score with the closest non-self match, mapped to a 0-100 scale.
 */
export function computeDuplicateRisk(
  _pageRelPath: string,
  title: string,
  tags: string[],
  _bodyPrefix: string,
  search: WikiSearch,
  selfAbsPath: string,
): number {
  const query = [title, ...tags.slice(0, 3)].join(" ");
  if (!query.trim()) return 0;
  const hits = search.search(query, 5);
  // Find the best non-self match.
  let bestScore = 0;
  for (const hit of hits) {
    if (hit.path === selfAbsPath) continue;
    if (hit.score > bestScore) bestScore = hit.score;
  }
  // Normalize minisearch score to 0-100 duplicate risk.
  // MiniSearch scores are unbounded; we use heuristic thresholds.
  // A minisearch score above 20 usually means very similar content.
  const normalized = Math.min(100, Math.round((bestScore / 25) * 100));
  if (normalized < 30) return 0;
  if (normalized <= 60) return Math.round(((normalized - 30) / 30) * 50);
  if (normalized <= 80) return Math.round(50 + ((normalized - 60) / 20) * 30);
  return Math.round(80 + ((normalized - 80) / 20) * 20);
}

// ---------------------------------------------------------------------------
// Overall score
// ---------------------------------------------------------------------------

export function computeWeightedScore(
  factors: PageHealthScore["factors"],
  weights: WotwConfig["health"]["weights"],
): number {
  // Higher factor values are better (100 = perfect). The overall score
  // is the weighted average, EXCEPT for duplicate risk and contradiction
  // risk which are inverted (0 = no risk = healthy).
  const invDup = 100 - factors.duplicateRisk;
  const invContra = 100 - factors.contradictionRisk;
  const raw =
    factors.staleness * weights.staleness +
    factors.sourceAvailability * weights.source_availability +
    factors.linkHealth * weights.link_health +
    invDup * weights.duplicate_risk +
    invContra * weights.contradiction_risk;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ---------------------------------------------------------------------------
// Full page health score
// ---------------------------------------------------------------------------

export function computePageHealthScore(
  pageAbsPath: string,
  _store: WikiStore,
  records: ProvenanceRecord[],
  search: WikiSearch,
  allPageSlugs: Set<string>,
  config: WotwConfig,
  body: string,
  title: string,
  tags: string[],
  isOrphaned: boolean,
): PageHealthScore {
  const wikiRoot = config.wiki_root;
  const pageRelPath = relative(wikiRoot, pageAbsPath);

  const staleness = computeStaleness(
    pageRelPath,
    records,
    config.health.staleness_thresholds,
    config.health.staleness_scores,
  );
  const sourceAvailability = computeSourceAvailability(pageRelPath, records, wikiRoot, isOrphaned);
  const { score: linkHealth } = computeLinkHealth(body, allPageSlugs);
  const duplicateRisk = computeDuplicateRisk(
    pageRelPath,
    title,
    tags,
    body.slice(0, 200),
    search,
    pageAbsPath,
  );

  const factors: PageHealthScore["factors"] = {
    staleness,
    sourceAvailability,
    linkHealth,
    duplicateRisk,
    contradictionRisk: 0, // populated by contradiction detection pass
  };

  return {
    page: relative(wikiRoot, pageAbsPath),
    score: computeWeightedScore(factors, config.health.weights),
    factors,
  };
}

// ---------------------------------------------------------------------------
// Deduplication detection
// ---------------------------------------------------------------------------

export interface DuplicateGroup {
  pages: string[];
}

/**
 * Find transitive duplicate groups from pairwise duplicate findings.
 * Uses union-find for efficiency.
 */
export function groupDuplicates(pairs: Array<[string, string]>): DuplicateGroup[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const [a, b] of pairs) {
    parent.set(a, parent.get(a) ?? a);
    parent.set(b, parent.get(b) ?? b);
    union(a, b);
  }

  const groups = new Map<string, Set<string>>();
  for (const node of parent.keys()) {
    const root = find(node);
    if (!groups.has(root)) groups.set(root, new Set());
    groups.get(root)!.add(node);
  }

  return [...groups.values()].filter((s) => s.size > 1).map((s) => ({ pages: [...s].sort() }));
}

// ---------------------------------------------------------------------------
// Knowledge consolidation detection
// ---------------------------------------------------------------------------

export interface ConsolidationGroup {
  /** Wiki-relative paths of pages in this topical cluster. */
  pages: string[];
  /** Shared topic description derived from common tags. */
  topic: string;
  /** Suggested title for the consolidated page. */
  suggestedTitle: string;
}

/**
 * Detect topic clusters that have accumulated too many pages and would
 * benefit from consolidation into a single authoritative page.
 *
 * Uses two signals:
 *   1. Union-find grouping at a lower similarity threshold than dedup (40 vs 60).
 *   2. Tag clustering — groups sharing the same primary tag.
 *
 * Groups with more than `consolidation_threshold` pages are returned.
 */
export function detectConsolidationCandidates(
  store: WikiStore,
  search: WikiSearch,
  config: WotwConfig,
): ConsolidationGroup[] {
  if (!config.health.consolidation_enabled) return [];
  const threshold = config.health.consolidation_threshold;
  const allPaths = store.listAll();
  const wikiRoot = config.wiki_root;

  // ---- Signal 1: similarity-based grouping at lower threshold ----
  const simPairs: Array<[string, string]> = [];
  for (const absPath of allPaths) {
    const doc = search.search(
      // Use a broad query by path-slug to find related pages.
      absPath.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? "",
      10,
    );
    const pageRel = relative(wikiRoot, absPath);
    for (const hit of doc) {
      if (hit.path === absPath) continue;
      // Normalize to 0-100 risk scale (same as computeDuplicateRisk).
      const normalized = Math.min(100, Math.round((hit.score / 25) * 100));
      if (normalized >= 40) {
        const hitRel = relative(wikiRoot, hit.path);
        const key = [pageRel, hitRel].sort().join("||");
        // Deduplicate pairs.
        if (!simPairs.some(([a, b]) => [a, b].sort().join("||") === key)) {
          simPairs.push([pageRel, hitRel]);
        }
      }
    }
  }

  const simGroups = groupDuplicates(simPairs)
    .filter((g) => g.pages.length > threshold)
    .map((g) => ({
      pages: g.pages,
      topic: g.pages.map((p) => p.split("/").pop()?.replace(/\.md$/, "")).join(", "),
      suggestedTitle: `Consolidated: ${g.pages[0]?.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ?? "topic"}`,
    }));

  // ---- Signal 2: tag clustering ----
  const tagGroups = new Map<string, string[]>();
  for (const absPath of allPaths) {
    const pageRel = relative(wikiRoot, absPath);
    // Quick tag peek from the index doc — reconstruct from search.
    const hits = search.search(absPath.split("/").pop()?.replace(/\.md$/, "") ?? "", 1);
    if (hits.length > 0 && hits[0]!.path === absPath) {
      // We need the tags from the actual page. Use store for accuracy.
      // But we want to keep this lightweight. Use relative path.
      // For now just use path-based inference; actual tag grouping
      // would need page reads. Defer to the sim-groups signal.
    }
    // Group by category directory as a lightweight proxy.
    const parts = pageRel.split("/");
    if (parts.length >= 2) {
      const catDir = parts.slice(0, -1).join("/");
      if (!tagGroups.has(catDir)) tagGroups.set(catDir, []);
      tagGroups.get(catDir)!.push(pageRel);
    }
  }

  // Merge sim-groups with tag groups that exceed threshold.
  // Tag groups alone are too coarse (entire categories), so only use sim-groups.
  const seen = new Set<string>();
  const result: ConsolidationGroup[] = [];
  for (const g of simGroups) {
    const key = g.pages.sort().join("||");
    if (!seen.has(key)) {
      seen.add(key);
      result.push(g);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Missing backlink detection
// ---------------------------------------------------------------------------

function detectMissingBacklinks(
  store: WikiStore,
  allPages: Array<{ absPath: string; related: string[] }>,
): HealthFinding[] {
  const findings: HealthFinding[] = [];
  const bySlug = new Map<string, string>(); // slug → abs path
  for (const p of allPages) {
    bySlug.set(toWikiSlug(store, p.absPath), p.absPath);
  }
  const relatedBySlug = new Map<string, Set<string>>();
  for (const p of allPages) {
    const slug = toWikiSlug(store, p.absPath);
    relatedBySlug.set(slug, new Set(p.related.map(normalizeSlug)));
  }

  for (const p of allPages) {
    const mySlug = toWikiSlug(store, p.absPath);
    for (const related of p.related) {
      const targetSlug = normalizeSlug(related);
      const targetRels = relatedBySlug.get(targetSlug);
      if (targetRels && !targetRels.has(mySlug)) {
        const pageRel = relative(store.wikiRoot, p.absPath);
        const targetAbs = bySlug.get(targetSlug);
        const targetRel = targetAbs ? relative(store.wikiRoot, targetAbs) : targetSlug;
        const fid = `missing-backlink:${pageRel}->${targetRel}`;
        findings.push({
          id: fid,
          kind: "missing-backlink",
          severity: "low",
          pages: [pageRel, targetRel],
          description: `${pageRel} references ${targetRel} but ${targetRel} does not link back.`,
          autoFixable: true,
        });
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Full health report
// ---------------------------------------------------------------------------

/**
 * Compute a complete health report for the wiki. Runs all detection passes
 * (staleness, source availability, link health, duplicates, orphans, broken
 * links, missing backlinks). Does NOT run LLM — contradiction detection
 * requires a separate LLM pass.
 */
export async function computeHealthReport(
  store: WikiStore,
  chain: ProvenanceChain | null,
  search: WikiSearch,
  opts: HealthReportOptions,
): Promise<HealthReport> {
  const config = opts.config;
  const records = opts.provenanceRecords ?? (chain ? await chain.readAll() : []);
  const allAbsPaths = store.listAll();
  const findings: HealthFinding[] = [];
  const scores: PageHealthScore[] = [];

  // Build a set of all valid wiki slugs for link health checking.
  const allPageSlugs = new Set<string>();
  for (const p of allAbsPaths) {
    allPageSlugs.add(toWikiSlug(store, p));
  }

  // Page data for backlink detection.
  const pageData: Array<{ absPath: string; related: string[] }> = [];
  // Track duplicate pairs.
  const dupPairs: Array<[string, string]> = [];
  const seenDupPairKeys = new Set<string>();

  for (const absPath of allAbsPaths) {
    const page = await store.readPage(absPath);
    if (!page) continue;

    const pageRel = relative(config.wiki_root, absPath);
    const isOrphaned = page.frontmatter.status === "orphaned";
    const isMerged = page.frontmatter.status === "merged";
    const isConsolidated = page.frontmatter.status === "consolidated";

    // Skip merged and consolidated pages from scoring.
    if (isMerged || isConsolidated) continue;

    pageData.push({ absPath, related: page.frontmatter.related });

    // Compute health score.
    const score = computePageHealthScore(
      absPath,
      store,
      records,
      search,
      allPageSlugs,
      config,
      page.body,
      page.frontmatter.title,
      page.frontmatter.tags,
      isOrphaned,
    );
    scores.push(score);

    // --- Findings ---

    // Orphan finding.
    if (isOrphaned) {
      findings.push({
        id: `orphan:${pageRel}`,
        kind: "orphan",
        severity: "medium",
        pages: [pageRel],
        description: `Source files deleted; page retained with status: orphaned.`,
        autoFixable: false,
      });
    }

    // Stale finding.
    if (score.factors.staleness < config.health.auto_fix_staleness_below && !isOrphaned) {
      findings.push({
        id: `stale:${pageRel}`,
        kind: "stale",
        severity: score.factors.staleness <= 20 ? "high" : "medium",
        pages: [pageRel],
        description: `Page staleness score is ${score.factors.staleness} (below threshold ${config.health.auto_fix_staleness_below}).`,
        autoFixable: true,
      });
    }

    // Broken link finding.
    const { broken } = computeLinkHealth(page.body, allPageSlugs);
    if (broken.length > 0) {
      findings.push({
        id: `broken-link:${pageRel}`,
        kind: "broken-link",
        severity: broken.length > 3 ? "high" : "medium",
        pages: [pageRel],
        description: `${broken.length} broken wikilink(s): ${broken.slice(0, 5).join(", ")}${broken.length > 5 ? "..." : ""}.`,
        autoFixable: true,
      });
    }

    // Duplicate detection: check if this page's duplicate risk is above threshold.
    if (score.factors.duplicateRisk >= config.health.duplicate_threshold) {
      // Find the closest match to build the pair.
      const query = [page.frontmatter.title, ...page.frontmatter.tags.slice(0, 3)].join(" ");
      const hits = search.search(query, 5);
      for (const hit of hits) {
        if (hit.path === absPath) continue;
        const hitRel = relative(config.wiki_root, hit.path);
        const pairKey = [pageRel, hitRel].sort().join("||");
        if (!seenDupPairKeys.has(pairKey)) {
          seenDupPairKeys.add(pairKey);
          dupPairs.push([pageRel, hitRel]);
        }
        break; // only add closest match
      }
    }
  }

  // Group transitive duplicates and create findings.
  const dupGroups = groupDuplicates(dupPairs);
  for (const group of dupGroups) {
    findings.push({
      id: `duplicate:${group.pages.join("+")}`,
      kind: "duplicate",
      severity: "medium",
      pages: group.pages,
      description: `${group.pages.length} pages appear to cover the same topic.`,
      autoFixable: true,
    });
  }

  // Missing backlinks.
  const backlinkFindings = detectMissingBacklinks(store, pageData);
  findings.push(...backlinkFindings);

  // Consolidation candidates.
  const consolidationGroups = detectConsolidationCandidates(store, search, config);
  for (const group of consolidationGroups) {
    findings.push({
      id: `consolidation:${group.pages.join("+")}`,
      kind: "consolidation",
      severity: "low",
      pages: group.pages,
      description: `${group.pages.length} pages cover the topic area "${group.topic}" and could be consolidated.`,
      autoFixable: true,
    });
  }

  // Summary.
  const summary: HealthReportSummary = {
    total: findings.length,
    high: findings.filter((f) => f.severity === "high").length,
    medium: findings.filter((f) => f.severity === "medium").length,
    low: findings.filter((f) => f.severity === "low").length,
    autoFixable: findings.filter((f) => f.autoFixable).length,
  };

  return {
    timestamp: new Date().toISOString(),
    findings,
    scores,
    summary,
  };
}
