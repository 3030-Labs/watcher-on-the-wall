/**
 * Daemon-side LLM provider abstraction.
 *
 * Types are vendored byte-identical from the canonical source at
 * wotw-cloud's packages/shared/src/llm/types.ts. The vendored copy lives
 * at ./types-vendored.ts and is enforced byte-identical by a CI script
 * in wotw-cloud (check-llm-types-sync.mjs).
 *
 * Provider implementations live in ./providers/ and are daemon-side only
 * (the daemon owns the runtime dependencies on @anthropic-ai/sdk, etc.).
 */

export type {
  LLMProviderName,
  FinishReason,
  CompletionOptions,
  CompletionUsage,
  CompletionResult,
  ValidateConnectionResult,
  LLMProvider,
} from "./types-vendored.js";

export { AnthropicProvider } from "./providers/anthropic.js";
export type { AnthropicProviderConfig } from "./providers/anthropic.js";

export { OpenAIProvider } from "./providers/openai.js";
export type { OpenAIProviderConfig } from "./providers/openai.js";

export { GeminiProvider } from "./providers/gemini.js";
export type { GeminiProviderConfig } from "./providers/gemini.js";

export { OllamaProvider } from "./providers/ollama.js";
export type { OllamaProviderConfig } from "./providers/ollama.js";

export { parseDaemonEditsResponse, resolveEditPath } from "./edits.js";
export type { DaemonEdit, DaemonEditsResponse } from "./edits.js";

export { runtimeAwareComplete } from "./runtime-aware.js";
export type { RuntimeAwareCompleteOptions, RuntimeAwareCompleteResult } from "./runtime-aware.js";
