/**
 * Heal handlers — LLM-powered auto-fix functions for health findings.
 *
 * Each handler takes a finding + context, invokes the ingestion agent with
 * a targeted prompt, records a "heal" provenance entry, and commits the
 * result. Handlers are dispatched by finding kind from `wotw lint --fix`.
 */
import { relative, resolve, sep } from "node:path";
import { commitWikiChanges } from "../ingestion/git-committer.js";
import type { InvokeResult } from "../ingestion/llm-invoker.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import { parseDaemonEditsResponse, resolveEditPath } from "../llm/edits.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import { sha256Files, sha256Hex } from "../provenance/hash.js";
import { getLogger } from "../utils/logger.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import { atomicWrite } from "../utils/fs.js";
import { repairBidirectionalLinks } from "./cross-reference.js";
import type { HealthFinding } from "./health.js";
import type { WikiSearch } from "./search.js";
import type { WikiStore } from "./store.js";
import { loadAllPages } from "../ingestion/wiki-writer.js";

export interface HealContext {
  config: WotwConfig;
  store: WikiStore;
  search: WikiSearch;
  provenance: ProvenanceChain | null;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  runtimeMode: RuntimeMode;
}

export interface HealResult {
  finding: HealthFinding;
  fixed: boolean;
  reason?: string;
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Stale page refresh
// ---------------------------------------------------------------------------

export async function healStale(finding: HealthFinding, ctx: HealContext): Promise<HealResult> {
  const log = getLogger("heal");
  const pageRel = finding.pages[0];
  if (!pageRel) return { finding, fixed: false, reason: "no page", costUsd: 0 };

  const absPath = `${ctx.config.wiki_root}/${pageRel}`;
  const page = await ctx.store.readPage(absPath);
  if (!page) return { finding, fixed: false, reason: "page not found", costUsd: 0 };

  // Build prompt with source material if available.
  const sourceInfo = page.frontmatter.sources.map((s) => `- ${s}`).join("\n");
  const prompt = [
    `Review and refresh this wiki page. It was last updated ${page.frontmatter.updated}.`,
    `Page path: ${pageRel}`,
    `Title: ${page.frontmatter.title}`,
    sourceInfo ? `Original source files:\n${sourceInfo}` : "No source files on record.",
    "",
    "Instructions:",
    "- Read the page and its source files (if they still exist).",
    "- Update any outdated information based on the source material.",
    "- If the source material is no longer available, add `status: stale` to the frontmatter but preserve all existing content.",
    "- Keep all existing frontmatter fields (title, category, tags, sources, related, confidence).",
    "- Update the `updated:` frontmatter field to today's date.",
    "- Do NOT create any new files.",
  ].join("\n");

  const result = await invokeHeal(ctx, prompt, "heal-refresh");
  if (!result) return { finding, fixed: false, reason: "LLM invocation failed", costUsd: 0 };
  // Review item 27: do not claim fixed:true when LLM emitted zero edits.
  // Without this gate, the lint loop refinds + regenerates + re-heals the
  // same finding next interval, burning cost indefinitely (item 30).
  if (!result.success || result.writtenPaths.length === 0) {
    return {
      finding,
      fixed: false,
      reason: "LLM emitted no edits",
      costUsd: result.totalCostUsd,
    };
  }

  // Rebuild search index after page mutation.
  ctx.search.rebuild(await loadAllPages(ctx.store));

  await recordHealProvenance(ctx, result, {
    heal_kind: "refresh",
    page: pageRel,
  });

  await commitHealChanges(ctx, result, "refresh", pageRel);
  log.info({ page: pageRel, cost: result.totalCostUsd }, "healed stale page");
  return { finding, fixed: true, costUsd: result.totalCostUsd };
}

// ---------------------------------------------------------------------------
// Duplicate merge
// ---------------------------------------------------------------------------

export async function healDuplicate(finding: HealthFinding, ctx: HealContext): Promise<HealResult> {
  const log = getLogger("heal");
  if (finding.pages.length < 2) {
    return { finding, fixed: false, reason: "need >=2 pages", costUsd: 0 };
  }

  const pageContents: string[] = [];
  for (const rel of finding.pages) {
    const abs = `${ctx.config.wiki_root}/${rel}`;
    const page = await ctx.store.readPage(abs);
    if (page) {
      pageContents.push(`--- ${rel} ---\n${page.raw}`);
    }
  }

  const prompt = [
    "These wiki pages appear to cover the same topic. Merge them into a single authoritative page.",
    "",
    "Pages to merge:",
    ...pageContents,
    "",
    "Instructions:",
    "- Choose the best title and keep the most complete content.",
    "- Preserve ALL unique information from every page.",
    "- Keep all source references from all pages.",
    "- Update the `related:` frontmatter to include references from all merged pages.",
    "- Write the merged page to the first page's path.",
    `- For each redundant page (${finding.pages.slice(1).join(", ")}):`,
    "  - Clear the body.",
    `  - Set frontmatter: status: merged, merged_into: ${finding.pages[0]}`,
    "  - Keep the title and category for reference.",
    "- Do NOT delete any files.",
  ].join("\n");

  const result = await invokeHeal(ctx, prompt, "heal-dedup");
  if (!result) return { finding, fixed: false, reason: "LLM invocation failed", costUsd: 0 };
  if (!result.success || result.writtenPaths.length === 0) {
    return {
      finding,
      fixed: false,
      reason: "LLM emitted no edits",
      costUsd: result.totalCostUsd,
    };
  }

  // Repair bidirectional links after merge.
  const allPages = await loadAllPages(ctx.store);
  const mutated = repairBidirectionalLinks(ctx.store, allPages);
  for (const p of mutated) {
    await ctx.store.writePage(p);
  }
  ctx.search.rebuild(await loadAllPages(ctx.store));
  // Review item 32: backlink-repair writes were missing from
  // wiki_files_written. Splice them into result.writtenPaths so the
  // chain records the full set of files this heal touched, not just
  // the LLM-emitted edits.
  for (const p of mutated) {
    if (!result.writtenPaths.includes(p.path)) result.writtenPaths.push(p.path);
  }

  await recordHealProvenance(ctx, result, {
    heal_kind: "dedup-merge",
    merged_pages: finding.pages.join(","),
    surviving_page: finding.pages[0] ?? "",
  });

  await commitHealChanges(ctx, result, "dedup-merge", finding.pages.join("+"));
  log.info({ pages: finding.pages, cost: result.totalCostUsd }, "healed duplicate pages");
  return { finding, fixed: true, costUsd: result.totalCostUsd };
}

// ---------------------------------------------------------------------------
// Broken link repair
// ---------------------------------------------------------------------------

export async function healBrokenLinks(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult> {
  const log = getLogger("heal");
  const pageRel = finding.pages[0];
  if (!pageRel) return { finding, fixed: false, reason: "no page", costUsd: 0 };

  // Build list of all valid page titles.
  const allPages = await loadAllPages(ctx.store);
  const validTitles = allPages
    .map((p) => `${relative(ctx.config.wiki_root, p.path)}: ${p.frontmatter.title}`)
    .join("\n");

  const prompt = [
    `This wiki page has broken [[wikilinks]]: ${finding.description}`,
    `Page path: ${pageRel}`,
    "",
    "Valid wiki pages and their titles:",
    validTitles,
    "",
    "Instructions:",
    "- Read the page.",
    "- For each broken link, either fix it to point to the correct existing page, or remove the link if no matching page exists.",
    "- Do NOT create any new pages.",
    "- Do NOT modify any other files.",
  ].join("\n");

  const result = await invokeHeal(ctx, prompt, "heal-links");
  if (!result) return { finding, fixed: false, reason: "LLM invocation failed", costUsd: 0 };
  if (!result.success || result.writtenPaths.length === 0) {
    return {
      finding,
      fixed: false,
      reason: "LLM emitted no edits",
      costUsd: result.totalCostUsd,
    };
  }

  // Rebuild search index after page mutation.
  ctx.search.rebuild(await loadAllPages(ctx.store));

  await recordHealProvenance(ctx, result, {
    heal_kind: "link-repair",
    page: pageRel,
  });

  await commitHealChanges(ctx, result, "link-repair", pageRel);
  log.info({ page: pageRel, cost: result.totalCostUsd }, "healed broken links");
  return { finding, fixed: true, costUsd: result.totalCostUsd };
}

// ---------------------------------------------------------------------------
// Missing backlink repair (no LLM needed)
// ---------------------------------------------------------------------------

export async function healMissingBacklinks(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult> {
  const log = getLogger("heal");
  const allPages = await loadAllPages(ctx.store);
  const mutated = repairBidirectionalLinks(ctx.store, allPages);

  if (mutated.length === 0) {
    return { finding, fixed: false, reason: "no mutations needed", costUsd: 0 };
  }

  for (const p of mutated) {
    await ctx.store.writePage(p);
  }

  // Rebuild search after writes.
  ctx.search.rebuild(await loadAllPages(ctx.store));

  // Record provenance (no LLM call, so no cost).
  if (ctx.provenance) {
    const writtenPaths = mutated.map((p) => p.path);
    const hashesByAbs = await sha256Files(writtenPaths);
    const wikiRoot = ctx.config.wiki_root;
    const wikiFileHashes: Record<string, string> = {};
    for (const abs of writtenPaths) {
      const h = hashesByAbs[abs];
      if (h) wikiFileHashes[relative(wikiRoot, abs)] = h;
    }
    await ctx.provenance.append({
      type: "heal",
      source_files: [],
      source_hashes: [],
      prompt_hash: sha256Hex("backlink-repair"),
      model_id: "none",
      response_hash: sha256Hex("backlink-repair"),
      wiki_files_written: Object.keys(wikiFileHashes),
      wiki_file_hashes_after: wikiFileHashes,
      metadata: {
        heal_kind: "backlink-repair",
        pages_fixed: mutated.length,
      },
    });
  }

  await commitWikiChanges({
    wikiRoot: ctx.config.wiki_root,
    paths: [...mutated.map((p) => p.path), ...(ctx.provenance ? [ctx.provenance.path] : [])],
    operationId: `heal-backlink-${Date.now()}`,
    operation: "heal",
    metadata: { heal_kind: "backlink-repair", pages_fixed: mutated.length },
  });

  log.info({ pagesFixed: mutated.length }, "healed missing backlinks");
  return { finding, fixed: true, costUsd: 0 };
}

// ---------------------------------------------------------------------------
// Contradiction resolution
// ---------------------------------------------------------------------------

export async function healContradiction(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult> {
  const log = getLogger("heal");
  if (finding.pages.length < 2) {
    return { finding, fixed: false, reason: "need >=2 pages", costUsd: 0 };
  }

  const pageContents: string[] = [];
  for (const rel of finding.pages) {
    const abs = `${ctx.config.wiki_root}/${rel}`;
    const page = await ctx.store.readPage(abs);
    if (page) {
      pageContents.push(`--- ${rel} ---\n${page.raw}`);
    }
  }

  const prompt = [
    `These two wiki pages contradict each other: ${finding.description}`,
    "",
    ...pageContents,
    "",
    "Instructions:",
    "- Read both pages and their source material (if available).",
    "- Determine which claim is better supported by the source material.",
    "- Update the incorrect page to resolve the contradiction.",
    "- If you cannot determine which is correct, add a `contradictions:` frontmatter field to both pages listing the unresolved conflict.",
    "- Do NOT create any new pages.",
  ].join("\n");

  const result = await invokeHeal(ctx, prompt, "heal-contradiction");
  if (!result) return { finding, fixed: false, reason: "LLM invocation failed", costUsd: 0 };
  if (!result.success || result.writtenPaths.length === 0) {
    return {
      finding,
      fixed: false,
      reason: "LLM emitted no edits",
      costUsd: result.totalCostUsd,
    };
  }

  // Rebuild search index after page mutation.
  ctx.search.rebuild(await loadAllPages(ctx.store));

  await recordHealProvenance(ctx, result, {
    heal_kind: "contradiction-resolve",
    pages: finding.pages.join(","),
  });

  await commitHealChanges(ctx, result, "contradiction-resolve", finding.pages.join("+"));
  log.info({ pages: finding.pages, cost: result.totalCostUsd }, "healed contradiction");
  return { finding, fixed: true, costUsd: result.totalCostUsd };
}

// ---------------------------------------------------------------------------
// Knowledge consolidation
// ---------------------------------------------------------------------------

export async function healConsolidation(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult> {
  const log = getLogger("heal");
  if (finding.pages.length < 2) {
    return { finding, fixed: false, reason: "need >=2 pages", costUsd: 0 };
  }

  const pageContents: string[] = [];
  for (const rel of finding.pages) {
    const abs = `${ctx.config.wiki_root}/${rel}`;
    const page = await ctx.store.readPage(abs);
    if (page) {
      pageContents.push(`--- ${rel} ---\n${page.raw}`);
    }
  }

  const suggestedTitle =
    finding.description.match(/"([^"]+)"/)?.[1] ??
    finding.pages[0]?.split("/").pop()?.replace(/\.md$/, "").replace(/[-_]/g, " ") ??
    "consolidated topic";

  const prompt = [
    `These ${finding.pages.length} pages all cover the same topic area: "${suggestedTitle}".`,
    "Merge them into a single authoritative page that preserves all unique information,",
    "removes redundancy, and maintains all source references.",
    `Title the consolidated page: "${suggestedTitle}".`,
    "",
    "Pages to consolidate:",
    ...pageContents,
    "",
    "Instructions:",
    "- Write the consolidated page to the first page's path.",
    "- Preserve ALL unique information from every page.",
    "- Keep all source references from all pages in the `sources:` frontmatter.",
    "- Merge all `related:` links.",
    "- Merge all `tags:` values (deduplicate).",
    "- Merge all `key_terms:` values (deduplicate).",
    "- Use the highest confidence level among the source pages.",
    `- For each original page EXCEPT the first (${finding.pages.slice(1).join(", ")}):`,
    `  - Clear the body.`,
    `  - Set frontmatter: status: consolidated, consolidated_into: ${finding.pages[0]}`,
    "  - Keep the title and category for reference.",
    "- Do NOT delete any files.",
  ].join("\n");

  const result = await invokeHeal(ctx, prompt, "heal-consolidation");
  if (!result) return { finding, fixed: false, reason: "LLM invocation failed", costUsd: 0 };
  if (!result.success || result.writtenPaths.length === 0) {
    return {
      finding,
      fixed: false,
      reason: "LLM emitted no edits",
      costUsd: result.totalCostUsd,
    };
  }

  // Repair bidirectional links after consolidation.
  const allPages = await loadAllPages(ctx.store);
  const mutated = repairBidirectionalLinks(ctx.store, allPages);
  for (const p of mutated) {
    await ctx.store.writePage(p);
  }
  ctx.search.rebuild(await loadAllPages(ctx.store));
  // Review item 32: include backlink-repair writes in wiki_files_written.
  for (const p of mutated) {
    if (!result.writtenPaths.includes(p.path)) result.writtenPaths.push(p.path);
  }

  await recordHealProvenance(ctx, result, {
    heal_kind: "consolidation",
    source_pages: finding.pages.join(","),
    consolidated_page: finding.pages[0] ?? "",
  });

  await commitHealChanges(ctx, result, "consolidation", finding.pages.join("+"));
  log.info({ pages: finding.pages, cost: result.totalCostUsd }, "consolidated topic pages");
  return { finding, fixed: true, costUsd: result.totalCostUsd };
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch a finding to the appropriate heal handler. Returns null for
 * finding kinds that cannot be auto-healed.
 */
/**
 * Review item 30: in-memory idempotency / backoff map for heal attempts.
 * Pre-fix, the same finding could be re-found by lint on each interval
 * and re-healed → unbounded provenance growth + cost burn in auto_fix
 * mode. Now: each finding.id is throttled to one attempt per HEAL_BACKOFF_MS
 * unless the prior attempt SUCCEEDED (fixed:true). Keyed by finding.id
 * so re-finding the same issue under the same id is recognized.
 *
 * Lives at module scope: tied to daemon process lifetime, which matches
 * the lint-scheduler's lifetime. Restart clears the map by design —
 * a fresh daemon takes a fresh look at the wiki.
 */
const healAttempts = new Map<string, { attemptedAt: number; lastFixed: boolean }>();
const HEAL_BACKOFF_MS = 6 * 60 * 60 * 1000; // 6 hours
function recordHealAttempt(id: string, fixed: boolean): void {
  healAttempts.set(id, { attemptedAt: Date.now(), lastFixed: fixed });
}
function shouldSkipHeal(id: string): boolean {
  const last = healAttempts.get(id);
  if (!last) return false;
  if (last.lastFixed) return false; // successful fixes don't block future re-attempts
  return Date.now() - last.attemptedAt < HEAL_BACKOFF_MS;
}

/** Test-only: reset the backoff state. */
export function _resetHealBackoffForTests(): void {
  healAttempts.clear();
}

export async function healFinding(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult | null> {
  // Review item 30: idempotency / backoff. Skip if a recent attempt
  // for this exact finding.id failed; let it rediscover after the
  // backoff window so cost-burn loops cannot form.
  if (shouldSkipHeal(finding.id)) {
    return { finding, fixed: false, reason: "heal backoff active", costUsd: 0 };
  }
  const dispatch = async (): Promise<HealResult | null> => {
    switch (finding.kind) {
      case "stale":
        return healStale(finding, ctx);
      case "duplicate":
        return healDuplicate(finding, ctx);
      case "broken-link":
        return healBrokenLinks(finding, ctx);
      case "missing-backlink":
        return healMissingBacklinks(finding, ctx);
      case "contradiction":
        return healContradiction(finding, ctx);
      case "consolidation":
        return healConsolidation(finding, ctx);
      case "orphan":
        // Already handled by archive system — not auto-fixable.
        return null;
      default:
        return null;
    }
  };
  const result = await dispatch();
  if (result) {
    recordHealAttempt(finding.id, result.fixed);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function invokeHeal(
  ctx: HealContext,
  userPrompt: string,
  label: string,
): Promise<InvokeResult | null> {
  const log = getLogger("heal");
  const model =
    ctx.runtimeMode === "cli" ? ctx.config.execution.cli_model : ctx.modelRouter.modelFor("lint");

  // Budget pre-flight (API mode only).
  if (ctx.runtimeMode !== "cli") {
    const estimated = ctx.modelRouter.computeCost(model, 8_000, 4_000);
    if (ctx.costTracker.wouldExceedDaily(estimated)) {
      log.warn({ label }, "skipping heal — daily budget exceeded");
      return null;
    }
  }

  const systemPrompt = [
    "You are a wiki maintenance agent. Apply the fix described in the user message.",
    "",
    "Return ONLY valid JSON with this shape, no other text:",
    `{ "edits": [ { "path": "wiki-relative-path-or-absolute.md", "content": "full new file content with frontmatter" } ] }`,
    "",
    'If no changes are needed, return: { "edits": [] }',
    "",
    "Rules:",
    "- The `content` field is the COMPLETE new file content, including YAML frontmatter.",
    "- Only emit edits for files the user prompt mentions or references.",
    "- Do NOT create new files unless explicitly asked.",
    "- Do NOT include any text outside the JSON object.",
  ].join("\n");

  const started = Date.now();
  let rawText = "";
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let durationMs = 0;

  try {
    const result = await runtimeAwareComplete(userPrompt, {
      systemPrompt,
      model,
      maxTokens: 16_384,
      config: ctx.config,
      runtimeMode: ctx.runtimeMode,
    });
    rawText = result.text;
    costUsd = result.costUsd;
    inputTokens = result.inputTokens;
    outputTokens = result.outputTokens;
    durationMs = result.durationMs;
  } catch (err) {
    log.error({ err, label }, "heal LLM invocation failed");
    return null;
  }

  ctx.costTracker.logUsage({
    operation: "heal",
    model,
    costUsd,
    inputTokens,
    outputTokens,
  });

  const parsed = parseDaemonEditsResponse(rawText);
  const writtenPaths: string[] = [];
  // Review item 28: heal writes used to call atomicWrite directly, bypassing
  // reconcileWrittenPages (which adds frontmatter normalization + provenance
  // footer + raw/ write-block). Now we (a) reject edits that target raw/, and
  // (b) reconcile through wiki-writer after writing so heal pages end up
  // shaped identically to ingestion pages.
  const rawPath = resolve(ctx.config.raw_path);
  if (parsed) {
    for (const edit of parsed.edits) {
      const absPath = resolveEditPath(ctx.config.wiki_root, edit.path);
      if (!absPath) {
        log.warn(
          { path: edit.path, label },
          "heal edit rejected — path resolves outside wiki_root",
        );
        continue;
      }
      if (absPath === rawPath || absPath.startsWith(`${rawPath}${sep}`)) {
        log.warn(
          { path: edit.path, label },
          "heal edit rejected — model attempted to write inside raw/",
        );
        continue;
      }
      try {
        await atomicWrite(absPath, edit.content);
        writtenPaths.push(absPath);
      } catch (err) {
        log.warn({ err, path: edit.path, label }, "heal edit failed to write — skipping");
      }
    }
  } else if (rawText.trim().length > 0) {
    log.warn({ label, sample: rawText.slice(0, 200) }, "heal response was not valid JSON edits");
  }

  // Reconcile written pages through the same pipeline ingestion uses so
  // heal outputs get last_compiled, source_count, last_confirmed,
  // superseded_by normalization + provenance footer applied uniformly.
  // Staging is disabled for heal — heal is fix-in-place semantics.
  if (writtenPaths.length > 0) {
    try {
      const { reconcileWrittenPages } = await import("../ingestion/wiki-writer.js");
      const { pages, skipped } = await reconcileWrittenPages(ctx.store, writtenPaths, {
        staging: false,
      });
      if (skipped.length > 0) {
        log.warn({ label, skipped }, "heal: some written paths skipped during reconcile");
      }
      // Replace writtenPaths with paths that actually survived reconcile.
      writtenPaths.length = 0;
      for (const p of pages) writtenPaths.push(p.path);
    } catch (err) {
      log.warn({ err, label }, "heal: reconcile failed");
    }
  }

  // Compose an InvokeResult-shaped object for the existing per-handler
  // contract. Phase 5 preserves the handler-facing shape; future phases
  // can simplify if/when invokeHeal's callers migrate.
  const _started = started; // appease eslint unused-var when durationMs path used
  void _started;

  return {
    finalText: rawText,
    totalCostUsd: costUsd,
    inputTokens,
    outputTokens,
    durationMs,
    numTurns: 1,
    sessionId: null,
    writtenPaths,
    stopReason: "end_turn",
    success: writtenPaths.length > 0,
  };
}

async function recordHealProvenance(
  ctx: HealContext,
  result: InvokeResult,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  if (!ctx.provenance) return;
  const wikiRoot = ctx.config.wiki_root;
  const toRel = (abs: string): string => relative(wikiRoot, abs) || abs;

  const writtenRels = result.writtenPaths.map(toRel);
  const hashesByAbs = await sha256Files(result.writtenPaths);
  const wikiFileHashes: Record<string, string> = {};
  for (const abs of result.writtenPaths) {
    const h = hashesByAbs[abs];
    if (h) wikiFileHashes[toRel(abs)] = h;
  }

  try {
    await ctx.provenance.append({
      type: "heal",
      source_files: [],
      source_hashes: [],
      prompt_hash: sha256Hex("heal"),
      model_id:
        result.writtenPaths.length > 0
          ? ctx.runtimeMode === "cli"
            ? ctx.config.execution.cli_model
            : ctx.modelRouter.modelFor("lint")
          : "none",
      response_hash: sha256Hex(result.finalText || ""),
      wiki_files_written: writtenRels,
      wiki_file_hashes_after: wikiFileHashes,
      metadata: {
        cost_usd: Number(result.totalCostUsd.toFixed(6)),
        duration_ms: result.durationMs,
        ...metadata,
      },
    });
  } catch (err) {
    getLogger("heal").error({ err }, "failed to append heal provenance record");
  }
}

async function commitHealChanges(
  ctx: HealContext,
  result: InvokeResult,
  healKind: string,
  target: string,
): Promise<void> {
  const paths = [...result.writtenPaths, ...(ctx.provenance ? [ctx.provenance.path] : [])];
  try {
    await commitWikiChanges({
      wikiRoot: ctx.config.wiki_root,
      paths: [...new Set(paths)],
      operationId: `heal-${healKind}-${Date.now()}`,
      operation: "heal",
      metadata: { heal_kind: healKind, target },
    });
  } catch (err) {
    getLogger("heal").warn({ err, healKind }, "heal commit failed (non-fatal)");
  }
}
