/**
 * OllamaProvider — single-pass completion via local Ollama HTTP API.
 *
 * No SDK dependency — Ollama's API is small enough to implement directly.
 * Default URL: http://localhost:11434. No API key (Ollama is local).
 *
 * Cost computation returns null — local inference has no API cost. The
 * daemon's cost tracker treats null as "free" downstream (CostTracker
 * accepts cost: 0 for skipping tracking).
 *
 * Conforms to LLMProvider. The /api/chat endpoint accepts:
 *   { model, messages: [{ role, content }], options: { num_predict, temperature, stop } }
 * and returns:
 *   { message: { role: "assistant", content }, prompt_eval_count, eval_count, done_reason }
 *
 * Stop reason mapping (Ollama's `done_reason`):
 *   - "stop"   → "end_turn"
 *   - "length" → "max_tokens"
 *   - everything else → "error"
 */
import type {
  CompletionOptions,
  CompletionResult,
  FinishReason,
  LLMProvider,
  ValidateConnectionResult,
} from "../types-vendored.js";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

function normalizeFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    default:
      return "error";
  }
}

interface OllamaChatResponse {
  message?: { role: string; content: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

interface OllamaTagsResponse {
  models?: Array<{ name: string }>;
}

export interface OllamaProviderConfig {
  /** Base URL of the Ollama instance. Defaults to localhost:11434. */
  baseURL?: string;
  /**
   * Optional fetch implementation (for testing). Defaults to globalThis.fetch.
   */
  fetchImpl?: typeof fetch;
}

export class OllamaProvider implements LLMProvider {
  readonly name = "ollama" as const;
  readonly supportsTools = false;

  private readonly baseURL: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OllamaProviderConfig = {}) {
    this.baseURL = config.baseURL ?? DEFAULT_OLLAMA_URL;
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
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

    const ollamaOptions: Record<string, unknown> = {};
    // Review item 11: Ollama's default num_predict is 128 — far below
    // what vocabulary-enricher / query-expansion / ingestion need.
    // Callers that don't set maxTokens get silent 128-token truncation.
    // Match the daemon's other providers' default of 4096.
    ollamaOptions.num_predict = options.maxTokens ?? 4096;
    if (options.temperature !== undefined) ollamaOptions.temperature = options.temperature;
    if (options.stopSequences && options.stopSequences.length > 0) {
      ollamaOptions.stop = options.stopSequences;
    }

    const body: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: false,
    };
    if (Object.keys(ollamaOptions).length > 0) body.options = ollamaOptions;

    const response = await this.fetchImpl(`${this.baseURL}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...(options.abortSignal ? { signal: options.abortSignal } : {}),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "(no body)");
      throw new Error(`ollama chat failed: ${response.status} ${errText.slice(0, 200)}`);
    }

    const data = (await response.json()) as OllamaChatResponse;
    const durationMs = Date.now() - started;
    const text = data.message?.content ?? "";

    return {
      text,
      usage: {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count ?? 0,
        totalCostUsd: null,
        durationMs,
        finishReason: normalizeFinishReason(data.done_reason),
      },
    };
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    try {
      const response = await this.fetchImpl(`${this.baseURL}/api/tags`);
      if (!response.ok) {
        return { valid: false, error: `ollama /api/tags returned ${response.status}` };
      }
      return { valid: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { valid: false, error };
    }
  }

  /** List available local models. Ollama-specific extension. */
  async listModels(): Promise<string[]> {
    const response = await this.fetchImpl(`${this.baseURL}/api/tags`);
    if (!response.ok) return [];
    const data = (await response.json()) as OllamaTagsResponse;
    return (data.models ?? []).map((m) => m.name);
  }
}
