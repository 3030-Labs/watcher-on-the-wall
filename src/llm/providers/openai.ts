/**
 * OpenAIProvider — single-pass completion via the OpenAI Chat Completions API.
 *
 * Conforms to the LLMProvider abstraction defined in the canonical
 * src/llm/types-vendored.ts (vendored from wotw-cloud). The interface
 * locks `complete(prompt, options) → Promise<string>` as the surface;
 * this provider's response shape (chat completion choice with .message.content)
 * maps to that interface.
 *
 * Stop-reason mapping:
 *   - "stop"         → "end_turn"
 *   - "length"       → "max_tokens"
 *   - everything else (tool_calls, content_filter, function_call) → "error"
 *
 * Pricing: GPT-4o + GPT-4o-mini + o1 + o1-mini as of 2026. Unknown models
 * fall back to GPT-4o pricing as a conservative ceiling.
 */
import OpenAI from "openai";
import type {
  CompletionOptions,
  CompletionResult,
  FinishReason,
  LLMProvider,
  ValidateConnectionResult,
} from "../types-vendored.js";

interface ModelPricing {
  input: number;
  output: number;
}

const PRICING: Readonly<Record<string, ModelPricing>> = {
  "gpt-4o": { input: 2.5, output: 10 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  o1: { input: 15, output: 60 },
  "o1-mini": { input: 3, output: 12 },
  "gpt-4-turbo": { input: 10, output: 30 },
};

const DEFAULT_PRICING: ModelPricing = { input: 2.5, output: 10 };

function normalizeFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "error";
  }
}

export interface OpenAIProviderConfig {
  apiKey?: string;
  baseURL?: string;
  client?: OpenAI;
}

export class OpenAIProvider implements LLMProvider {
  readonly name = "openai" as const;
  readonly supportsTools = true;

  private readonly client: OpenAI;

  constructor(config: OpenAIProviderConfig = {}) {
    if (config.client) {
      this.client = config.client;
    } else {
      this.client = new OpenAI({
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

    const messages: { role: "system" | "user"; content: string }[] = [];
    if (options.systemPrompt) {
      messages.push({ role: "system", content: options.systemPrompt });
    }
    messages.push({ role: "user", content: prompt });

    const response = await this.client.chat.completions.create(
      {
        model: options.model,
        messages,
        max_tokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0
          ? { stop: options.stopSequences }
          : {}),
      },
      options.abortSignal ? { signal: options.abortSignal } : undefined,
    );

    const durationMs = Date.now() - started;
    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";
    const inputTokens = response.usage?.prompt_tokens ?? 0;
    const outputTokens = response.usage?.completion_tokens ?? 0;
    const totalCostUsd = this.computeCost(options.model, inputTokens, outputTokens);

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs,
        finishReason: normalizeFinishReason(choice?.finish_reason),
      },
    };
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    try {
      // Cheap validation: list models.
      await this.client.models.list();
      return { valid: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { valid: false, error };
    }
  }

  computeCost(modelId: string, inputTokens: number, outputTokens: number): number {
    const pricing = PRICING[modelId] ?? DEFAULT_PRICING;
    return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  }
}
