/**
 * Heal handlers — LLM-powered auto-fix functions for health findings.
 *
 * Each handler takes a finding + context, invokes the ingestion agent with
 * a targeted prompt, records a "heal" provenance entry, and commits the
 * result. Handlers are dispatched by finding kind from `wotw lint --fix`.
 */
import { isAbsolute, relative, resolve } from "node:path";
import { commitWikiChanges } from "../ingestion/git-committer.js";
import type { InvokeResult } from "../ingestion/llm-invoker.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
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

  // Repair bidirectional links after merge.
  const allPages = await loadAllPages(ctx.store);
  const mutated = repairBidirectionalLinks(ctx.store, allPages);
  for (const p of mutated) {
    await ctx.store.writePage(p);
  }
  ctx.search.rebuild(await loadAllPages(ctx.store));

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

  // Repair bidirectional links after consolidation.
  const allPages = await loadAllPages(ctx.store);
  const mutated = repairBidirectionalLinks(ctx.store, allPages);
  for (const p of mutated) {
    await ctx.store.writePage(p);
  }
  ctx.search.rebuild(await loadAllPages(ctx.store));

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
export async function healFinding(
  finding: HealthFinding,
  ctx: HealContext,
): Promise<HealResult | null> {
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
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * JSON shape the model must emit for heal operations. The daemon parses
 * this and performs the file writes itself; no in-call Write/Edit tools.
 */
interface HealEdit {
  /** Wiki-relative or absolute path of the file to write. */
  path: string;
  /** Full new file content (including frontmatter). */
  content: string;
}

interface HealResponse {
  edits: HealEdit[];
}

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

  const parsed = parseHealResponse(rawText);
  const writtenPaths: string[] = [];
  if (parsed) {
    for (const edit of parsed.edits) {
      const absPath = resolveHealEditPath(ctx.config.wiki_root, edit.path);
      if (!absPath) {
        log.warn(
          { path: edit.path, label },
          "heal edit rejected — path resolves outside wiki_root",
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

/**
 * Parse the heal response text into a HealResponse. The prompt asks for
 * JSON-only output, but defensively extracts the first `{...}` block and
 * tolerates surrounding whitespace, markdown fences, or stray text.
 * Returns null if no valid HealResponse shape can be extracted.
 */
function parseHealResponse(text: string): HealResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Extract the first {...} block. Greedy match works since the response
  // is supposed to be JSON-only; if the model wraps in a fence we still
  // pick up the inner JSON.
  const match = trimmed.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { edits?: unknown }).edits)
  ) {
    return null;
  }
  const editsRaw = (parsed as { edits: unknown[] }).edits;
  const edits: HealEdit[] = [];
  for (const e of editsRaw) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as HealEdit).path === "string" &&
      typeof (e as HealEdit).content === "string"
    ) {
      edits.push({
        path: (e as HealEdit).path,
        content: (e as HealEdit).content,
      });
    }
  }
  return { edits };
}

/**
 * Resolve a heal-edit path (wiki-relative or absolute) to an absolute
 * path. Rejects paths that escape `wikiRoot` via `..` or absolute paths
 * outside the wiki tree. Returns null on rejection.
 */
function resolveHealEditPath(wikiRoot: string, p: string): string | null {
  const candidate = isAbsolute(p) ? resolve(p) : resolve(wikiRoot, p);
  const root = resolve(wikiRoot);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    return null;
  }
  return candidate;
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
