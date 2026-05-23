/**
 * Fact extractor — the LLM-driven side of the Pass B layer.
 *
 * For a given wiki page, this module runs a single LLM call that
 * returns BOTH the atomic facts (Yanhong Li / TTIC factual
 * decomposition) AND the synthetic questions (Cambridge ALTA) for each
 * fact. Combining them in one round trip is the cheapest path: an
 * average page emits ~5-10 facts × 3 questions, and that's still one
 * provider call's worth of tokens.
 *
 * The daemon writes the result to {@link FactStore} and appends a
 * `fact_extracted` provenance record with the new + superseded
 * fact_hashes.
 *
 * Gating (cost-free by default):
 *   - Ollama (local inference): zero per-call cost.
 *   - Claude Code CLI: subscription-covered (zero metered cost).
 *   - API mode (Anthropic / OpenAI / Gemini): opt-in via
 *     `fact_extraction.force_enabled` to avoid silently amplifying
 *     per-ingest cost.
 *
 * Pass 008 BYOK: extraction goes through the existing
 * `runtimeAwareComplete` wrapper, which honors the daemon's
 * provider-construction-time key read. No keys are logged or persisted
 * by this module.
 */
import { getLogger } from "../utils/logger.js";
import { runtimeAwareComplete } from "../llm/runtime-aware.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";

/** Hard cap on the body bytes we feed to extraction. Matches query-engine. */
const MAX_PAGE_BODY_BYTES = 16 * 1024;

export interface ExtractedFact {
  entity: string;
  statement: string;
  questions: string[];
}

export interface ExtractFactsResult {
  facts: ExtractedFact[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Raw LLM response text — kept for provenance hashing. */
  rawResponse: string;
  /** True when the LLM call ran (false on skip due to gating). */
  ran: boolean;
  /** Human-readable reason when ran=false. */
  skipReason?: string;
}

export interface IsExtractionActiveResult {
  active: boolean;
  reason: string;
}

/**
 * Determine whether fact extraction should run given the daemon's
 * configured `fact_extraction.enabled` + the resolved runtime mode +
 * the configured provider. The reason string is stable and surfaced
 * in the daemon startup banner so the operator can see at a glance
 * why the layer is on or off.
 */
export function isExtractionActive(
  config: WotwConfig,
  runtimeMode: RuntimeMode,
): IsExtractionActiveResult {
  const fx = config.fact_extraction;
  if (fx.enabled === false) {
    return { active: false, reason: "fact_extraction.enabled=false (explicit)" };
  }
  if (fx.enabled === true) {
    return { active: true, reason: "fact_extraction.enabled=true (explicit)" };
  }
  // enabled === "auto"
  if (runtimeMode === "cli") {
    return {
      active: true,
      reason: "auto + runtime=cli (Claude Code CLI is subscription-covered, no metered cost)",
    };
  }
  if (config.llm.provider === "ollama") {
    return {
      active: true,
      reason: "auto + provider=ollama (local inference, no metered cost)",
    };
  }
  if (fx.force_enabled) {
    return {
      active: true,
      reason: `auto + force_enabled=true + provider=${config.llm.provider} (operator opt-in to metered extraction)`,
    };
  }
  return {
    active: false,
    reason: `auto + metered provider=${config.llm.provider} (set fact_extraction.force_enabled=true to opt in)`,
  };
}

export interface ExtractFactsOptions {
  config: WotwConfig;
  runtimeMode: RuntimeMode;
  /** Wiki-relative page path, only used in the prompt for context. */
  wikiPageId: string;
  /** Markdown body of the page (will be byte-clamped to 16 KB). */
  pageBody: string;
  /** Page title, used to anchor the prompt. */
  title: string;
  costTracker: CostTracker;
  /** Override the model. Defaults to config.models.lint. */
  model?: string;
}

/**
 * Run a single LLM call that emits atomic facts + N synthetic questions
 * per fact for the supplied page. Returns the parsed result + cost
 * telemetry. When extraction is gated off, returns `{ ran: false, ... }`
 * without making an LLM call.
 */
export async function extractFactsFromPage(opts: ExtractFactsOptions): Promise<ExtractFactsResult> {
  const log = getLogger("fact-extractor");
  const active = isExtractionActive(opts.config, opts.runtimeMode);
  if (!active.active) {
    return {
      facts: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      rawResponse: "",
      ran: false,
      skipReason: active.reason,
    };
  }

  const started = Date.now();
  const model =
    opts.model ??
    opts.config.fact_extraction.model ??
    (opts.runtimeMode === "cli" ? opts.config.execution.cli_model : opts.config.models.lint);
  const questionsPerFact = clampQuestionsPerFact(opts.config.fact_extraction.questions_per_fact);
  const body = byteClamp(opts.pageBody, MAX_PAGE_BODY_BYTES);

  const systemPrompt = buildSystemPrompt(questionsPerFact);
  const userPrompt = buildUserPrompt(opts.title, opts.wikiPageId, body, questionsPerFact);

  let result;
  try {
    result = await runtimeAwareComplete(userPrompt, {
      systemPrompt,
      model,
      config: opts.config,
      runtimeMode: opts.runtimeMode,
      maxTokens: 4096,
    });
  } catch (err) {
    log.warn(
      {
        err: err instanceof Error ? err.message.slice(0, 120) : "unknown",
        wikiPageId: opts.wikiPageId,
      },
      "fact extraction LLM call failed",
    );
    return {
      facts: [],
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - started,
      rawResponse: "",
      ran: true,
      skipReason: "llm_error",
    };
  }

  opts.costTracker.logUsage({
    operation: "fact_extraction",
    model,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
  });

  const facts = parseFactsResponse(result.text);
  return {
    facts,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: Date.now() - started,
    rawResponse: result.text,
    ran: true,
  };
}

function clampQuestionsPerFact(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 3;
  return Math.max(1, Math.min(5, Math.floor(value)));
}

function byteClamp(text: string, capBytes: number): string {
  const byteLen = Buffer.byteLength(text, "utf8");
  if (byteLen <= capBytes) return text;
  return Buffer.from(text, "utf8").subarray(0, capBytes).toString("utf8");
}

function buildSystemPrompt(questionsPerFact: number): string {
  return `You are a fact-extraction assistant for a knowledge wiki.

For the wiki page provided, return a JSON object of the shape:
{
  "facts": [
    {
      "entity": "<short noun phrase identifying the subject>",
      "statement": "<single declarative sentence about the entity>",
      "questions": ["<question 1>", "<question 2>", ...]
    }
  ]
}

Rules:
- Each fact must be a single atomic claim about exactly one entity.
- "entity" should be a noun phrase of 1-6 words.
- "statement" should be a single declarative sentence; do not include hedges or speculation.
- Emit ${questionsPerFact} synthetic questions per fact that a user might ask whose answer is that fact.
- Cover the page comprehensively but do not invent facts not present in the page.
- Skip rhetorical / aspirational sentences ("we believe", "may", "could").
- Respond ONLY with the JSON object, no surrounding prose, no markdown fences.`;
}

function buildUserPrompt(
  title: string,
  wikiPageId: string,
  body: string,
  questionsPerFact: number,
): string {
  return `Wiki page: ${title}
Path: ${wikiPageId}

Body:
${body}

Return the JSON fact decomposition with ${questionsPerFact} questions per fact.`;
}

/**
 * Parse the LLM response into a list of {@link ExtractedFact}. Tolerates
 * markdown fences (`\`\`\`json ... \`\`\``) and stray prose around the
 * JSON object. Returns an empty array on any parse failure so a single
 * malformed extraction doesn't fail the surrounding ingestion.
 */
export function parseFactsResponse(text: string): ExtractedFact[] {
  if (!text || typeof text !== "string") return [];
  // Strip code fences if present.
  let s = text.trim();
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced && fenced[1]) s = fenced[1].trim();
  // Try to locate the first {...} block.
  const objMatch = s.match(/\{[\s\S]*\}/);
  if (!objMatch) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const factsField = (parsed as { facts?: unknown }).facts;
  if (!Array.isArray(factsField)) return [];
  const out: ExtractedFact[] = [];
  for (const raw of factsField) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const entity = typeof r.entity === "string" ? r.entity.trim() : "";
    const statement = typeof r.statement === "string" ? r.statement.trim() : "";
    if (!entity || !statement) continue;
    const questions: string[] = Array.isArray(r.questions)
      ? r.questions
          .filter((q): q is string => typeof q === "string")
          .map((q) => q.trim())
          .filter((q) => q.length > 0)
      : [];
    out.push({ entity, statement, questions });
  }
  return out;
}
