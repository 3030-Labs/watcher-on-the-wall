/**
 * Token estimator. Returns token counts for a given text + provider so the
 * `estimate_query_cost` MCP tool (Feature Pass 006) can report retrieval
 * payload size to the client LLM *before* the client commits to a query.
 *
 * Default method is a 4-chars-per-token heuristic that matches the daemon's
 * existing CLI-mode approximation (`src/ingestion/cli-invoker.ts:206`). This
 * is fast, deterministic, and good to ~10-15% on English prose. Power users
 * who need exact counts pass `precise: true` to invoke the provider-native
 * tokenizer:
 *
 *   - Anthropic: `client.messages.countTokens()` (free, network call).
 *   - Gemini:    `model.countTokens()` (free, network call).
 *   - OpenAI:    tiktoken would be required (not installed). Falls back.
 *   - Ollama:    no client-side tokenizer. Falls back.
 *
 * BYOK invariants (Pass 008): the daemon reads the API key from its
 * environment at provider-construction time; we do not log the key, persist
 * it, or echo it in error messages. Network failures fall back to the
 * heuristic so a transient DNS hiccup doesn't break `estimate_query_cost`.
 *
 * Confidence + method are surfaced in the response so the client LLM can
 * reason about whether to trust the estimate (e.g., a 1000-token approximate
 * estimate is fine for a "do I have budget?" check; an exact count matters
 * if the client is right at its context-window limit).
 */
import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { getLogger } from "../utils/logger.js";
import type { LlmProviderName } from "../utils/types.js";
import { CHARS_PER_TOKEN, charsToTokens } from "./truncate.js";

export type TokenEstimateConfidence = "exact" | "approximate";

export type TokenEstimateMethod =
  | "anthropic-count-tokens"
  | "gemini-count-tokens"
  | "openai-tiktoken"
  | "ollama-llama-cpp"
  | "4-char-heuristic"
  | "fallback-heuristic";

export interface TokenEstimate {
  /** Token count for the supplied text. */
  tokens: number;
  /** Whether the count is from a provider-native tokenizer or a heuristic. */
  confidence: TokenEstimateConfidence;
  /** Which tokenizer or heuristic produced the count. */
  method: TokenEstimateMethod;
  /** Provider the estimate is sized for. */
  provider: LlmProviderName | null;
  /** Model identifier the estimate is sized for. */
  model: string | null;
}

export interface EstimateTokensOptions {
  /** Provider the estimate should target. Defaults to no specific provider. */
  provider?: LlmProviderName;
  /** Model identifier. Required for Anthropic/Gemini precise counts. */
  model?: string;
  /** When true, attempt the provider-native tokenizer. */
  precise?: boolean;
  /**
   * Optional Anthropic SDK client. When omitted, a fresh client is
   * constructed using ANTHROPIC_API_KEY (or the env var named in
   * `apiKeyEnv`). Exposed for tests.
   */
  anthropicClient?: Anthropic;
  /**
   * Optional Gemini SDK client. When omitted, a fresh client is constructed
   * using GOOGLE_API_KEY (or the env var named in `apiKeyEnv`).
   */
  geminiClient?: GoogleGenerativeAI;
  /** Env var to read the provider API key from. */
  apiKeyEnv?: string;
}

/**
 * 4-chars-per-token heuristic. Deterministic, network-free, and good to
 * ~10-15% on English prose. The result is rounded up so the estimate is
 * never silently under the true count.
 */
export function heuristicTokens(text: string): number {
  return charsToTokens(text.length);
}

/**
 * Estimate the token count for `text` under the supplied provider/model.
 * Falls back to the 4-char heuristic on any provider-native failure.
 */
export async function estimateTokens(
  text: string,
  opts: EstimateTokensOptions = {},
): Promise<TokenEstimate> {
  const provider = opts.provider ?? null;
  const model = opts.model ?? null;
  const heuristic: TokenEstimate = {
    tokens: heuristicTokens(text),
    confidence: "approximate",
    method: "4-char-heuristic",
    provider,
    model,
  };

  if (!opts.precise) return heuristic;
  if (!provider) return heuristic;

  if (provider === "anthropic" && model) {
    return (await anthropicCountTokens(text, model, opts)) ?? withFallback(heuristic);
  }
  if (provider === "gemini" && model) {
    return (await geminiCountTokens(text, model, opts)) ?? withFallback(heuristic);
  }
  // OpenAI tiktoken + Ollama llama.cpp are not bundled — the daemon
  // deliberately keeps its dependency surface narrow. Operators who want
  // precise OpenAI counts install tiktoken separately; until then we
  // surface the heuristic with an explicit "approximate" tag so the
  // caller knows not to treat it as authoritative.
  return heuristic;
}

function withFallback(heuristic: TokenEstimate): TokenEstimate {
  return { ...heuristic, method: "fallback-heuristic" };
}

async function anthropicCountTokens(
  text: string,
  model: string,
  opts: EstimateTokensOptions,
): Promise<TokenEstimate | null> {
  const log = getLogger("token-estimator");
  try {
    const client = opts.anthropicClient ?? buildAnthropicClient(opts);
    if (!client) return null;
    const result = await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: text }],
    });
    return {
      tokens: result.input_tokens,
      confidence: "exact",
      method: "anthropic-count-tokens",
      provider: "anthropic",
      model,
    };
  } catch (err) {
    // Network / 401 / unknown model — fall back. Don't surface raw error
    // strings: SDK errors may contain hostname / path / token fragments.
    log.warn(
      { err: err instanceof Error ? err.message.slice(0, 120) : "unknown" },
      "anthropic count_tokens failed; falling back to heuristic",
    );
    return null;
  }
}

async function geminiCountTokens(
  text: string,
  model: string,
  opts: EstimateTokensOptions,
): Promise<TokenEstimate | null> {
  const log = getLogger("token-estimator");
  try {
    const client = opts.geminiClient ?? buildGeminiClient(opts);
    if (!client) return null;
    const generativeModel = client.getGenerativeModel({ model });
    const result = await generativeModel.countTokens({
      contents: [{ role: "user", parts: [{ text }] }],
    });
    return {
      tokens: result.totalTokens,
      confidence: "exact",
      method: "gemini-count-tokens",
      provider: "gemini",
      model,
    };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message.slice(0, 120) : "unknown" },
      "gemini countTokens failed; falling back to heuristic",
    );
    return null;
  }
}

function buildAnthropicClient(opts: EstimateTokensOptions): Anthropic | null {
  const envName = opts.apiKeyEnv ?? "ANTHROPIC_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) return null;
  return new Anthropic({ apiKey });
}

function buildGeminiClient(opts: EstimateTokensOptions): GoogleGenerativeAI | null {
  const envName = opts.apiKeyEnv ?? "GOOGLE_API_KEY";
  const apiKey = process.env[envName];
  if (!apiKey) return null;
  return new GoogleGenerativeAI(apiKey);
}

/**
 * Convenience: return heuristic estimates for all four providers when no
 * specific provider is requested. The caller (estimate_query_cost) renders
 * this as a four-row table so the client LLM can pick the cheapest one.
 */
export function heuristicEstimatesAllProviders(text: string): TokenEstimate[] {
  const providers: LlmProviderName[] = ["anthropic", "openai", "gemini", "ollama"];
  return providers.map((provider) => ({
    tokens: heuristicTokens(text),
    confidence: "approximate" as const,
    method: "4-char-heuristic" as const,
    provider,
    model: null,
  }));
}

/** Re-export the heuristic boundary so consumers don't have to import twice. */
export { CHARS_PER_TOKEN };
