/**
 * Runtime-aware completion wrapper.
 *
 * The wotw daemon supports two LLM runtime modes:
 *   - "api": metered Anthropic API call (BYOK ANTHROPIC_API_KEY).
 *   - "cli": spawn the user's locally-installed `claude` CLI binary
 *     (free with a Claude Pro/Max subscription).
 *
 * The `LLMProvider` abstraction (Phase 1 lock) is API-mode-only by design
 * — provider-agnostic across API providers (Anthropic, OpenAI, Gemini,
 * Ollama). CLI mode is Anthropic-only by construction; it cannot be
 * routed through a non-Anthropic provider.
 *
 * This wrapper holds both runtime modes together so call sites
 * (query-expansion, vocabulary-enricher, future migrated callers) don't
 * branch on `runtimeMode` themselves. API mode goes through the provider
 * abstraction; CLI mode preserves the existing `invokeIngestionAgent` /
 * `invokeClaudeCli` subprocess path.
 *
 * Phase 10 will wire per-tenant provider selection (the API mode branch
 * will pick AnthropicProvider / OpenAIProvider / GeminiProvider /
 * OllamaProvider per `wiki.llm_provider`). For Phases 2-6 the API mode
 * branch is hardcoded to AnthropicProvider — the migration target is
 * the abstraction shape, not the provider count.
 */
import { invokeIngestionAgent } from "../ingestion/llm-invoker.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import type { LLMProvider } from "./types-vendored.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { OpenAIProvider } from "./providers/openai.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OllamaProvider } from "./providers/ollama.js";

export interface RuntimeAwareCompleteOptions {
  /** Logical model identifier (provider-specific). */
  model: string;
  /** Optional system prompt. */
  systemPrompt?: string;
  /** Maximum tokens in the response. Default: 4096 (API mode), N/A (CLI). */
  maxTokens?: number;
  /** Sampling temperature, 0-1. Default: provider default. */
  temperature?: number;
  /** Stop sequences. */
  stopSequences?: string[];
  /** Abort signal. */
  abortSignal?: AbortSignal;
  /** Daemon config (needed for CLI mode subprocess + API key env var name). */
  config: WotwConfig;
  /** Resolved runtime mode (cli or api). */
  runtimeMode: RuntimeMode;
}

/**
 * Result shape unifies the API-mode (`AnthropicProvider.completeWithUsage`)
 * and CLI-mode (`invokeIngestionAgent` subprocess) outputs. CLI mode
 * doesn't report cost (free with subscription) — cost is 0.
 */
export interface RuntimeAwareCompleteResult {
  text: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /**
   * Review item 16: provider stop reason — propagated up so callers can
   * detect max-tokens truncation. `"length"` / `"max_tokens"` (provider-
   * specific) means the response was cut off mid-output; downstream
   * JSON-edits parsers should treat that as a hard parse-error not a
   * model-said-no-edits. CLI mode doesn't expose this — null.
   */
  finishReason: string | null;
}

/**
 * Single-pass completion that dispatches to the right runtime.
 *
 * API mode → AnthropicProvider.completeWithUsage (Messages API direct).
 * CLI mode → invokeIngestionAgent with maxTurns=1, allowedTools=[]
 *           (spawns claude binary; subprocess returns a single response).
 *
 * CLI mode currently flows through invokeIngestionAgent for compatibility;
 * Phase 6 may revisit whether the spawn machinery can be simplified now
 * that the multi-turn use cases are gone, but for Phase 2 the path is
 * preserved as-is.
 */
export async function runtimeAwareComplete(
  prompt: string,
  options: RuntimeAwareCompleteOptions,
): Promise<RuntimeAwareCompleteResult> {
  if (options.runtimeMode === "cli") {
    const result = await invokeIngestionAgent({
      cwd: options.config.wiki_root,
      systemPrompt: options.systemPrompt ?? "",
      userPrompt: prompt,
      model: options.model,
      maxTurns: 1,
      allowedTools: [],
      abortController: options.abortSignal
        ? abortSignalToController(options.abortSignal)
        : undefined,
      runtimeMode: "cli",
      cliConfig: {
        cliPath: options.config.execution.cli_path,
        cliModel: options.config.execution.cli_model,
      },
    });
    return {
      text: result.finalText,
      costUsd: result.totalCostUsd,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      durationMs: result.durationMs,
      // Review item 16: CLI subprocess shape doesn't expose finish reason.
      finishReason: null,
    };
  }

  // API mode: select provider based on config.llm.provider. Phase 10
  // wires per-tenant selection across Anthropic / OpenAI / Gemini / Ollama.
  const provider = selectProvider(options.config);
  const result = await provider.completeWithUsage(prompt, {
    model: options.model,
    systemPrompt: options.systemPrompt,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
    stopSequences: options.stopSequences,
    abortSignal: options.abortSignal,
  });

  return {
    text: result.text,
    costUsd: result.usage.totalCostUsd ?? 0,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    durationMs: result.usage.durationMs,
    // Review item 16: surface provider finish reason so consumers can
    // detect max-tokens truncation. Without this, partial-JSON responses
    // are silently parsed as "model emitted no edits" — looks like a
    // successful no-op when it's actually a hard truncation.
    finishReason: result.usage.finishReason ?? null,
  };
}

/**
 * Construct the configured LLM provider. Reads `config.llm.provider`
 * (default "anthropic") and instantiates the matching provider with
 * its API key from `config.execution.api_key_env` (or for Ollama, the
 * configured `config.llm.ollama_url` or default localhost:11434).
 *
 * Per Pass 008 BYOK invariant: the daemon reads the API key from its
 * environment at provider-construction time; the cloud-side orchestrator
 * injects the correct key under the correct env var at spawn time.
 */
function selectProvider(config: WotwConfig): LLMProvider {
  const providerName = config.llm.provider;
  if (providerName === "anthropic") {
    return new AnthropicProvider({
      apiKey: process.env[config.execution.api_key_env],
    });
  }
  if (providerName === "openai") {
    return new OpenAIProvider({
      apiKey: process.env[config.execution.api_key_env],
    });
  }
  if (providerName === "gemini") {
    return new GeminiProvider({
      apiKey: process.env[config.execution.api_key_env],
    });
  }
  // ollama
  return new OllamaProvider({ baseURL: config.llm.ollama_url });
}

/**
 * Adapter: invokeIngestionAgent expects an AbortController, but the
 * LLMProvider interface takes an AbortSignal. Wrap the signal.
 */
function abortSignalToController(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) {
    controller.abort();
  } else {
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller;
}
