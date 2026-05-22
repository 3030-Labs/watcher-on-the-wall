/**
 * LLMProvider abstraction. Single source of truth for the provider-agnostic
 * completion interface consumed by the wotw daemon (watcher-on-the-wall) and
 * any other surface that calls into an LLM provider.
 *
 * Canonical algorithm: matches the Full Architectural Design Layer 6 lock.
 * The daemon-side migration to import from this shared module is companion
 * work — until that lands, the two copies (this file and
 * watcher-on-the-wall/src/llm/types-vendored.ts) MUST stay byte-identical.
 * Any change to the LLMProvider interface, CompletionOptions, CompletionResult,
 * or LLMProviderName MUST land in both places in the same commit batch.
 *
 * Design intent:
 *   - `complete()` returns a string. This matches the architectural lock.
 *     Callers that don't care about cost/usage telemetry use this path.
 *   - `completeWithUsage()` returns text + usage. The wotw daemon's cost
 *     tracker consumes this path to log per-operation cost into provenance.
 *   - `supportsTools` is a capability flag, not a feature toggle. Indicates
 *     whether the provider's underlying API exposes structured tool calling.
 *     The daemon's refactored pipeline does NOT use tool-use at the
 *     interface boundary — it pre-assembles context, the model returns
 *     structured text, the daemon parses and writes files itself. The
 *     supportsTools flag is informational for callers that want to do
 *     in-call tool-use (out of scope for Phase 1).
 *
 * Out of scope at this interface:
 *   - Streaming responses (provider implementations may stream internally
 *     for long completions; the boundary is a single Promise<string>).
 *   - Multi-turn agent loops (the Agent SDK shape is deliberately not
 *     reproduced here — the architecture moved away from agent-loop
 *     ingestion to single-pass structured-response).
 *   - Tool-use at the boundary (see supportsTools note above).
 */

/** Logical provider identifier. */
export type LLMProviderName = "anthropic" | "openai" | "gemini" | "ollama";

/** Completion finish reason, normalized across providers. */
export type FinishReason = "end_turn" | "max_tokens" | "stop_sequence" | "error";

/**
 * Per-call completion options. Required `model` matches the daemon's
 * existing per-operation model routing (ModelRouter selects ingest/query/
 * lint/compound_eval models from config).
 */
export interface CompletionOptions {
  /**
   * Logical model identifier. Provider-specific
   * (e.g., "claude-sonnet-4-5", "gpt-4o", "gemini-2.0-pro",
   * "llama3.3:70b").
   */
  model: string;
  /** Optional system prompt (instructions). Provider-agnostic. */
  systemPrompt?: string;
  /** Maximum tokens in the response. Default: provider-specific. */
  maxTokens?: number;
  /** Sampling temperature, 0-1. Default: provider-specific. */
  temperature?: number;
  /** Stop sequences. Provider-specific support. */
  stopSequences?: string[];
  /** Abort signal for cancellation. */
  abortSignal?: AbortSignal;
}

/** Token + cost telemetry from a single completion. */
export interface CompletionUsage {
  /** Input tokens consumed (best-effort across providers). */
  inputTokens: number;
  /** Output tokens generated (best-effort across providers). */
  outputTokens: number;
  /**
   * USD cost. null if the provider does not expose pricing (e.g., Ollama
   * local inference). Computed by the provider implementation per its
   * pricing model.
   */
  totalCostUsd: number | null;
  /** Wall-clock duration of the completion call, in milliseconds. */
  durationMs: number;
  /** Provider's reported finish reason, normalized. */
  finishReason: FinishReason;
}

/** Extended completion result: text + usage telemetry. */
export interface CompletionResult {
  /** The text completion. */
  text: string;
  /** Token + cost telemetry. */
  usage: CompletionUsage;
}

/** Result of validating provider connectivity + credentials. */
export interface ValidateConnectionResult {
  /** True if connection + credentials work. */
  valid: boolean;
  /** Human-readable error description when valid=false. */
  error?: string;
}

/**
 * Provider-agnostic LLM interface. Single-pass completion only.
 *
 * The locked architectural surface is `complete(prompt, options) → Promise<string>`
 * — a thin completion call. `completeWithUsage()` is provided as an
 * extension for callers that need cost/telemetry alongside the text;
 * implementations of one method MUST be consistent with the other (same
 * call, same model, same prompt → same text).
 */
export interface LLMProvider {
  /** Provider name. */
  readonly name: LLMProviderName;
  /**
   * Whether this provider's underlying API supports tool-calling. Capability
   * flag, not a feature toggle — the wotw daemon's refactored pipeline does
   * not use tool-use at the interface boundary regardless.
   */
  readonly supportsTools: boolean;

  /**
   * Single-pass completion. Returns the text response. Use this path when
   * usage telemetry is not needed (e.g., query-expansion auxiliary calls).
   */
  complete(prompt: string, options: CompletionOptions): Promise<string>;

  /**
   * Single-pass completion with usage telemetry. Same call as `complete()`
   * but returns text + token counts + cost + duration + finish reason.
   * Use this path when cost tracking or provenance recording is required
   * (e.g., daemon ingestion pipeline).
   */
  completeWithUsage(prompt: string, options: CompletionOptions): Promise<CompletionResult>;

  /**
   * Validate provider connectivity + credentials. Cheap call against the
   * provider's identity/models endpoint. Used by settings UI's "Validate
   * connection" button and by daemon startup checks in hosted mode.
   */
  validateConnection(): Promise<ValidateConnectionResult>;
}
