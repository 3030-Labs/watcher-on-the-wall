/**
 * AnthropicProvider — single-pass completion via the Anthropic Messages API.
 *
 * This provider intentionally does NOT use @anthropic-ai/claude-agent-sdk
 * (the Claude Code Agent SDK). The architectural design Layer 6 locks the
 * provider interface as single-pass `complete(prompt, options) → string`.
 * The Agent SDK's multi-turn tool-use shape is preserved only in legacy
 * call sites that have not yet been migrated (queue.ts, heal-handlers.ts,
 * compounding/engine.ts, query-engine.ts as of Phase 1).
 *
 * Cost computation lives here, not in ModelRouter. The provider knows its
 * own pricing model best, and centralising cost in the provider keeps the
 * abstraction self-contained. Unknown models fall back to Opus-tier
 * pricing (conservative — overestimates cost so budget guardrails trip
 * before real money is spent).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { TextBlock } from "@anthropic-ai/sdk/resources/messages";
import type {
  CompletionOptions,
  CompletionResult,
  FinishReason,
  LLMProvider,
  ValidateConnectionResult,
} from "../types-vendored.js";

/** Price table in USD per 1M tokens. Mirrors src/ingestion/model-router.ts. */
interface ModelPricing {
  input: number;
  output: number;
}

/** Known Anthropic model pricing as of 2026. */
const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-4-7": { input: 15, output: 75 },
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

/** Conservative fallback for unknown models (Opus-tier). */
const DEFAULT_PRICING: ModelPricing = { input: 15, output: 75 };

/**
 * Normalize Anthropic's StopReason to our FinishReason enum.
 *
 * Anthropic's `tool_use`, `pause_turn`, and `refusal` map to "error"
 * because they're unexpected in a single-pass completion call (we don't
 * pass tools, we don't enable thinking-pause budgets, and a refusal is
 * a failure mode). `null` (which the SDK type allows) also maps to
 * "error" — completion ended without a recognised reason.
 */
function normalizeFinishReason(
  reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null,
): FinishReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "error";
  }
}

/** Configuration for constructing an AnthropicProvider instance. */
export interface AnthropicProviderConfig {
  /**
   * API key. If omitted, the Anthropic SDK reads from
   * process.env.ANTHROPIC_API_KEY at construction time.
   */
  apiKey?: string;
  /**
   * Optional base URL override (for testing or custom endpoints). The
   * SDK default points at api.anthropic.com.
   */
  baseURL?: string;
  /**
   * Optional pre-constructed SDK client. When provided, apiKey + baseURL
   * are ignored. Primarily used in tests to inject a mock.
   */
  client?: Anthropic;
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic" as const;
  readonly supportsTools = true;

  private readonly client: Anthropic;

  constructor(config: AnthropicProviderConfig = {}) {
    if (config.client) {
      this.client = config.client;
    } else {
      this.client = new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
      });
    }
  }

  async complete(prompt: string, options: CompletionOptions): Promise<string> {
    const result = await this.completeWithUsage(prompt, options);
    return result.text;
  }

  async completeWithUsage(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
    const started = Date.now();

    const response = await this.client.messages.create(
      {
        model: options.model,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0
          ? { stop_sequences: options.stopSequences }
          : {}),
        messages: [{ role: "user", content: prompt }],
      },
      options.abortSignal ? { signal: options.abortSignal } : undefined,
    );

    const durationMs = Date.now() - started;

    // Extract text from response content blocks. Single-pass completion
    // typically returns one or more text blocks; concatenate them. Non-text
    // blocks (tool_use, thinking, etc.) are filtered out — we don't pass
    // tools at the interface boundary, but the SDK's response shape is a
    // union so we narrow defensively.
    const text = response.content
      .filter((block): block is TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const totalCostUsd = this.computeCost(options.model, inputTokens, outputTokens);

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs,
        finishReason: normalizeFinishReason(response.stop_reason),
      },
    };
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    try {
      // Cheap validation: list models. Anthropic's models endpoint
      // returns paginated results; we just need a 200.
      await this.client.models.list({ limit: 1 });
      return { valid: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { valid: false, error };
    }
  }

  /**
   * Compute USD cost for a completion. Uses the model-specific price
   * entry if known; falls back to Opus-tier pricing for unknown models.
   * Exposed for tests + diagnostics.
   */
  computeCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[modelId] ?? DEFAULT_PRICING;
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }
}
