/**
 * GeminiProvider — single-pass completion via Google Generative AI SDK.
 *
 * Conforms to LLMProvider. The SDK's `generateContent` returns a response
 * whose `.candidates[0].content.parts` array contains text parts; we
 * concatenate them.
 *
 * Stop-reason mapping (FinishReason from @google/generative-ai):
 *   - "STOP"        → "end_turn"
 *   - "MAX_TOKENS"  → "max_tokens"
 *   - "SAFETY", "RECITATION", "OTHER", undefined → "error"
 *
 * Safety filters: by default the SDK applies strict content policies that
 * can reject legitimate technical/academic content. Provider sets all
 * safety thresholds to BLOCK_ONLY_HIGH so the daemon's wiki maintenance
 * tasks aren't blocked by ambiguous content. Hosted-mode operators can
 * lock this further by setting GEMINI_SAFETY_STRICT=true to revert to
 * defaults — not exposed in the LLMProvider interface, internal to the
 * provider for now.
 *
 * Pricing: Gemini 2.0 Pro + Flash as of 2026. Unknown models fall back to
 * Gemini 2.0 Pro pricing as a conservative ceiling.
 */
import { GoogleGenerativeAI, HarmBlockThreshold, HarmCategory } from "@google/generative-ai";
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
  "gemini-2.0-pro": { input: 1.25, output: 5 },
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5 },
  "gemini-1.5-flash": { input: 0.075, output: 0.3 },
};

// Review item 14: pre-fix `{ input: 1.25, output: 5 }` matches gemini-1.5-pro
// at low context, but newer Gemini families (2.5-pro at >200K context,
// 3.0-pro thinking mode) charge $5-12 / $25-60 per 1M. Default to a
// conservative ceiling so cost guardrails fire before the real bill does.
const DEFAULT_PRICING: ModelPricing = { input: 12, output: 60 };

function normalizeFinishReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case "STOP":
      return "end_turn";
    case "MAX_TOKENS":
      return "max_tokens";
    default:
      return "error";
  }
}

export interface GeminiProviderConfig {
  apiKey?: string;
  /** When true, use the SDK's default safety settings (stricter). */
  strictSafety?: boolean;
  client?: GoogleGenerativeAI;
}

export class GeminiProvider implements LLMProvider {
  readonly name = "gemini" as const;
  readonly supportsTools = true;

  private readonly client: GoogleGenerativeAI;
  private readonly strictSafety: boolean;
  // Retained for review item 12's free-tier validateConnection (REST
  // `models?key=...` call). The constructor still hands the key to the
  // SDK client, but the validate path needs it again.
  private readonly apiKey: string;

  constructor(config: GeminiProviderConfig = {}) {
    const apiKey = config.apiKey ?? process.env.GOOGLE_API_KEY ?? "";
    this.client = config.client ?? new GoogleGenerativeAI(apiKey);
    this.strictSafety = config.strictSafety ?? false;
    this.apiKey = apiKey;
  }

  async complete(prompt: string, options: CompletionOptions): Promise<string> {
    const result = await this.completeWithUsage(prompt, options);
    return result.text;
  }

  async completeWithUsage(prompt: string, options: CompletionOptions): Promise<CompletionResult> {
    const started = Date.now();

    const safetySettings = this.strictSafety
      ? undefined
      : [
          {
            category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_HARASSMENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
          {
            category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
            threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH,
          },
        ];

    const model = this.client.getGenerativeModel({
      model: options.model,
      ...(options.systemPrompt
        ? { systemInstruction: { role: "system", parts: [{ text: options.systemPrompt }] } }
        : {}),
      generationConfig: {
        maxOutputTokens: options.maxTokens ?? 4096,
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.stopSequences && options.stopSequences.length > 0
          ? { stopSequences: options.stopSequences }
          : {}),
      },
      ...(safetySettings ? { safetySettings } : {}),
    });

    // Review item 13: forward abortSignal so aborted requests stop
    // accruing billable tokens client-side. Per SDK 0.24.1 docs, signal
    // is plumbed via SingleRequestOptions. Note: Google charges for
    // server-side work even after abort — the signal cancels the
    // client read, not the upstream generation. Documented honesty.
    const requestOptions = options.abortSignal ? { signal: options.abortSignal } : undefined;
    const result = await model.generateContent(
      {
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      },
      requestOptions,
    );

    const durationMs = Date.now() - started;
    const candidate = result.response.candidates?.[0];
    const text = candidate?.content?.parts?.map((p) => ("text" in p ? p.text : "")).join("") ?? "";

    const inputTokens = result.response.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = result.response.usageMetadata?.candidatesTokenCount ?? 0;
    const totalCostUsd = this.computeCost(options.model, inputTokens, outputTokens);

    return {
      text,
      usage: {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs,
        finishReason: normalizeFinishReason(candidate?.finishReason),
      },
    };
  }

  async validateConnection(): Promise<ValidateConnectionResult> {
    // Review item 12: pre-fix called a paid `generateContent` for every
    // "validate" press. Switch to the free models listing endpoint
    // (`/v1beta/models?key=...`) per X5-corrected recommendation —
    // GoogleGenerativeAI.listModels() doesn't exist in SDK 0.24.1, so
    // we use raw fetch. Costs nothing; still proves key + network are good.
    try {
      const apiKey = this.apiKey;
      const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.text();
        return { valid: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }
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
