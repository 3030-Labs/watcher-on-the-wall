/**
 * `estimate_query_cost` MCP tool implementation.
 *
 * The client LLM hits this before committing to `query` or
 * `query_progressive` so it can budget. We compute the retrieval payload
 * the daemon *would* assemble (top-k pages, truncated to 16 KB each, same
 * as `query-engine.ts`), then count tokens against the chosen provider
 * tokenizer.
 *
 * Important: this is the token count for the daemon's *retrieval payload*,
 * not the full LLM round trip. The completion the client's LLM generates
 * on top of this payload is its own line item; the estimate tells the
 * client how big the retrieval grounding will be, full stop.
 *
 * Provider parameter:
 *   - omitted → returns heuristic estimates for all four providers (4-char
 *     approximation, marked confidence: "approximate")
 *   - "anthropic" / "gemini" / "openai" / "ollama" → returns one estimate
 *     for that provider; when precise: true *and* the daemon has the
 *     matching BYOK key, the provider-native tokenizer is invoked.
 *
 * Defaults:
 *   - precise: false (heuristic; network-free, deterministic)
 *   - k: 8 (matches query-engine DEFAULT_K)
 */
import type { LlmProviderName, WotwConfig } from "../utils/types.js";
import type { WikiSearch } from "../wiki/search.js";
import type { WikiStore } from "../wiki/store.js";
import {
  estimateTokens,
  heuristicEstimatesAllProviders,
  type TokenEstimate,
} from "./token-estimator.js";

const DEFAULT_K = 8;
const MAX_PAGE_BODY_BYTES = 16 * 1024;

export interface EstimateQueryCostOptions {
  store: WikiStore;
  search: WikiSearch;
  config: WotwConfig;
  /** Optional provider override. Falls back to env var, then "all". */
  provider?: LlmProviderName;
  /** Optional model identifier. Used by Anthropic/Gemini exact paths. */
  model?: string;
  /** Whether to attempt the provider-native tokenizer. */
  precise?: boolean;
  /** Top-k hits to include in the simulated payload. Default 8. */
  k?: number;
}

export interface EstimateQueryCostResult {
  /** Original question, echoed for client-side debugging. */
  question: string;
  /**
   * Per-provider token estimates. Length 1 when a specific provider was
   * requested; length 4 when no provider was named (one row per provider).
   */
  estimates: TokenEstimate[];
  /** Number of BM25 hits that contributed to the payload. */
  hit_count: number;
  /** Cap the daemon would have applied to each page body, in bytes. */
  per_page_byte_cap: number;
  /** Total characters in the assembled payload string. */
  retrieval_payload_chars: number;
  /** True when the BM25 corpus turned up zero matches. */
  no_hits: boolean;
}

/**
 * Build the same retrieval payload the daemon would hand to `query`'s
 * single-pass synthesis call, then run the token estimator over it. We
 * pre-fetch page bodies in parallel and clamp each to 16 KB to match
 * `query-engine.ts:27` exactly — divergence here would make the estimate
 * lie.
 */
export async function estimateQueryCost(
  question: string,
  opts: EstimateQueryCostOptions,
): Promise<EstimateQueryCostResult> {
  const k = opts.k && opts.k > 0 ? Math.floor(opts.k) : DEFAULT_K;
  const hits = opts.search.search(question, k);
  if (hits.length === 0) {
    return {
      question,
      estimates:
        opts.provider !== undefined
          ? [zeroEstimate(opts.provider, opts.model ?? null)]
          : heuristicEstimatesAllProviders(""),
      hit_count: 0,
      per_page_byte_cap: MAX_PAGE_BODY_BYTES,
      retrieval_payload_chars: 0,
      no_hits: true,
    };
  }

  // Pre-fetch + clamp identical to query-engine.
  const bodies = await Promise.all(
    hits.map(async (hit) => {
      try {
        const page = await opts.store.readPage(hit.path);
        if (!page) return hit.snippet;
        if (page.body.length > MAX_PAGE_BODY_BYTES) {
          return page.body.slice(0, MAX_PAGE_BODY_BYTES);
        }
        return page.body;
      } catch {
        return hit.snippet;
      }
    }),
  );

  // Render the same skeleton the query engine renders (title + path + body
  // + separator) so the token estimate reflects the real payload, not the
  // page bodies in isolation.
  const lines: string[] = [];
  lines.push("# Question");
  lines.push("");
  lines.push(question);
  lines.push("");
  lines.push(`# Retrieved wiki pages (${hits.length})`);
  lines.push("");
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const body = bodies[i] ?? "";
    lines.push(`## ${h.title}  (score ${h.score.toFixed(3)})`);
    lines.push(`path: ${opts.store.relativePath(h.path)}`);
    lines.push("");
    lines.push(body);
    lines.push("");
  }
  const payload = lines.join("\n");

  const estimates = await produceEstimates(payload, opts);

  return {
    question,
    estimates,
    hit_count: hits.length,
    per_page_byte_cap: MAX_PAGE_BODY_BYTES,
    retrieval_payload_chars: payload.length,
    no_hits: false,
  };
}

/**
 * Produce one or more {@link TokenEstimate} rows, depending on whether the
 * caller named a specific provider. The default (no provider) renders the
 * heuristic across all four providers; that's the "I want to compare" path.
 */
async function produceEstimates(
  payload: string,
  opts: EstimateQueryCostOptions,
): Promise<TokenEstimate[]> {
  const requested = opts.provider ?? resolveDefaultProvider(opts.config);
  if (!requested) {
    // No specific provider asked for and no daemon default. Render heuristic
    // estimates for all four so the client can compare.
    return heuristicEstimatesAllProviders(payload);
  }
  const estimate = await estimateTokens(payload, {
    provider: requested,
    model: opts.model,
    precise: opts.precise ?? false,
    apiKeyEnv: opts.config.execution.api_key_env,
  });
  return [estimate];
}

/**
 * Resolve the daemon-default provider from config. Returns the configured
 * provider when the user-facing default is not explicitly overridden.
 * Today this is just `config.llm.provider`; the indirection leaves room
 * for environment-driven overrides if we add them later.
 */
function resolveDefaultProvider(config: WotwConfig): LlmProviderName | null {
  const envProvider = process.env.WOTW_LLM_PROVIDER as LlmProviderName | undefined;
  if (
    envProvider === "anthropic" ||
    envProvider === "openai" ||
    envProvider === "gemini" ||
    envProvider === "ollama"
  ) {
    return envProvider;
  }
  return config.llm?.provider ?? null;
}

function zeroEstimate(provider: LlmProviderName, model: string | null): TokenEstimate {
  return {
    tokens: 0,
    confidence: "approximate",
    method: "4-char-heuristic",
    provider,
    model,
  };
}
