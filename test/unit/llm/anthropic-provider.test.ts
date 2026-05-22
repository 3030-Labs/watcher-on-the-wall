import { describe, expect, it, vi } from "vitest";
import { AnthropicProvider } from "../../../src/llm/providers/anthropic.js";
import type { CompletionOptions } from "../../../src/llm/types-vendored.js";

/**
 * Unit tests for AnthropicProvider. The Anthropic SDK is mocked via the
 * config.client injection seam — no network calls, deterministic responses.
 *
 * The provider is single-pass: it calls messages.create() once and returns
 * the concatenated text + usage. We test the contract surface (name,
 * supportsTools, complete, completeWithUsage, validateConnection,
 * computeCost) without depending on the Agent SDK at all.
 */

interface MockResponse {
  content: Array<{ type: string; text?: string }>;
  stop_reason:
    | "end_turn"
    | "max_tokens"
    | "stop_sequence"
    | "tool_use"
    | "pause_turn"
    | "refusal"
    | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface MockClient {
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  client: {
    messages: { create: ReturnType<typeof vi.fn> };
    models: { list: ReturnType<typeof vi.fn> };
  };
}

function makeMockClient(response: MockResponse, modelsListResponse?: unknown): MockClient {
  const create = vi.fn().mockResolvedValue(response);
  const list = vi.fn().mockResolvedValue(modelsListResponse ?? { data: [] });
  return {
    create,
    list,
    client: {
      messages: { create },
      models: { list },
    },
  };
}

describe("AnthropicProvider", () => {
  it("has name='anthropic' and supportsTools=true", () => {
    const provider = new AnthropicProvider({ apiKey: "test" });
    expect(provider.name).toBe("anthropic");
    expect(provider.supportsTools).toBe(true);
  });

  it("complete() returns concatenated text from response content blocks", async () => {
    const mock = makeMockClient({
      content: [
        { type: "text", text: "Hello, " },
        { type: "text", text: "world." },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const text = await provider.complete("prompt text", {
      model: "claude-sonnet-4-5",
      maxTokens: 100,
    });

    expect(text).toBe("Hello, world.");
    expect(mock.create).toHaveBeenCalledTimes(1);
  });

  it("completeWithUsage() returns text + usage with cost computed", async () => {
    const mock = makeMockClient({
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1000, output_tokens: 500 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const result = await provider.completeWithUsage("prompt", {
      model: "claude-sonnet-4-5",
      maxTokens: 100,
    });

    expect(result.text).toBe("answer");
    expect(result.usage.inputTokens).toBe(1000);
    expect(result.usage.outputTokens).toBe(500);
    // claude-sonnet-4-5: input $3/M, output $15/M
    // cost = (1000 * 3 + 500 * 15) / 1e6 = (3000 + 7500) / 1e6 = 0.0105
    expect(result.usage.totalCostUsd).toBeCloseTo(0.0105, 6);
    expect(result.usage.finishReason).toBe("end_turn");
    expect(result.usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("forwards systemPrompt, temperature, stopSequences to messages.create", async () => {
    const mock = makeMockClient({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    await provider.complete("p", {
      model: "claude-haiku-4-5",
      maxTokens: 50,
      systemPrompt: "be brief",
      temperature: 0.3,
      stopSequences: ["END"],
    });

    const args = mock.create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5");
    expect(args.max_tokens).toBe(50);
    expect(args.system).toBe("be brief");
    expect(args.temperature).toBe(0.3);
    expect(args.stop_sequences).toEqual(["END"]);
    expect(args.messages).toEqual([{ role: "user", content: "p" }]);
  });

  it("omits system, temperature, stop_sequences when not provided", async () => {
    const mock = makeMockClient({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    await provider.complete("p", { model: "claude-sonnet-4-5" });

    const args = mock.create.mock.calls[0][0];
    expect(args.system).toBeUndefined();
    expect(args.temperature).toBeUndefined();
    expect(args.stop_sequences).toBeUndefined();
    expect(args.max_tokens).toBe(4096); // default
  });

  it("defaults max_tokens to 4096 when not provided", async () => {
    const mock = makeMockClient({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    await provider.complete("p", { model: "claude-sonnet-4-5" });

    const args = mock.create.mock.calls[0][0];
    expect(args.max_tokens).toBe(4096);
  });

  it("normalizes finish reason: end_turn/max_tokens/stop_sequence pass through", async () => {
    const provider = new AnthropicProvider({ apiKey: "test" });

    for (const reason of ["end_turn", "max_tokens", "stop_sequence"] as const) {
      const mock = makeMockClient({
        content: [{ type: "text", text: "x" }],
        stop_reason: reason,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      // Need a fresh provider per case with the new mock.
      const p = new AnthropicProvider({
        client: mock.client as unknown as ConstructorParameters<
          typeof AnthropicProvider
        >[0]["client"],
      });
      const result = await p.completeWithUsage("p", { model: "claude-sonnet-4-5" });
      expect(result.usage.finishReason).toBe(reason);
    }
    // dummy assertion to satisfy typed-loop pattern
    expect(provider.name).toBe("anthropic");
  });

  it("normalizes finish reason: tool_use/pause_turn/refusal/null all map to 'error'", async () => {
    for (const reason of ["tool_use", "pause_turn", "refusal", null] as const) {
      const mock = makeMockClient({
        content: [{ type: "text", text: "x" }],
        stop_reason: reason,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
      const p = new AnthropicProvider({
        client: mock.client as unknown as ConstructorParameters<
          typeof AnthropicProvider
        >[0]["client"],
      });
      const result = await p.completeWithUsage("p", { model: "claude-sonnet-4-5" });
      expect(result.usage.finishReason).toBe("error");
    }
  });

  it("filters non-text content blocks (e.g., tool_use) out of the text result", async () => {
    const mock = makeMockClient({
      content: [
        { type: "text", text: "before " },
        { type: "tool_use" },
        { type: "text", text: "after" },
      ],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const text = await provider.complete("p", { model: "claude-sonnet-4-5" });
    expect(text).toBe("before after");
  });

  it("handles empty content array gracefully (returns empty string)", async () => {
    const mock = makeMockClient({
      content: [],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 0 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const text = await provider.complete("p", { model: "claude-sonnet-4-5" });
    expect(text).toBe("");
  });

  it("forwards abort signal to SDK call", async () => {
    const mock = makeMockClient({
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const controller = new AbortController();
    await provider.complete("p", {
      model: "claude-sonnet-4-5",
      abortSignal: controller.signal,
    });

    // Second positional arg is request options; should carry the signal.
    const callOptions = mock.create.mock.calls[0][1];
    expect(callOptions?.signal).toBe(controller.signal);
  });

  it("validateConnection() returns {valid: true} on successful models.list", async () => {
    const mock = makeMockClient(
      {
        content: [{ type: "text", text: "" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 0, output_tokens: 0 },
      },
      { data: [{ id: "claude-sonnet-4-5" }] },
    );
    const provider = new AnthropicProvider({
      client: mock.client as unknown as ConstructorParameters<
        typeof AnthropicProvider
      >[0]["client"],
    });

    const result = await provider.validateConnection();
    expect(result.valid).toBe(true);
    expect(mock.list).toHaveBeenCalledTimes(1);
  });

  it("validateConnection() returns {valid: false, error} on SDK error", async () => {
    const list = vi.fn().mockRejectedValue(new Error("401 unauthorized"));
    const create = vi.fn();
    const provider = new AnthropicProvider({
      client: {
        messages: { create },
        models: { list },
      } as unknown as ConstructorParameters<typeof AnthropicProvider>[0]["client"],
    });

    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/401 unauthorized/);
  });

  describe("computeCost", () => {
    const provider = new AnthropicProvider({ apiKey: "test" });

    it("computes cost for sonnet-4-5: $3 input + $15 output per 1M tokens", () => {
      expect(provider.computeCost("claude-sonnet-4-5", 1_000_000, 0)).toBe(3);
      expect(provider.computeCost("claude-sonnet-4-5", 0, 1_000_000)).toBe(15);
      expect(provider.computeCost("claude-sonnet-4-5", 500_000, 500_000)).toBeCloseTo(9, 6);
    });

    it("computes cost for haiku-4-5: $1 input + $5 output per 1M tokens", () => {
      expect(provider.computeCost("claude-haiku-4-5", 1_000_000, 0)).toBe(1);
      expect(provider.computeCost("claude-haiku-4-5-20251001", 0, 1_000_000)).toBe(5);
    });

    it("computes cost for opus-4-7: $15 input + $75 output per 1M tokens", () => {
      expect(provider.computeCost("claude-opus-4-7", 1_000_000, 0)).toBe(15);
      expect(provider.computeCost("claude-opus-4-7", 0, 1_000_000)).toBe(75);
    });

    it("falls back to Opus-tier ($15/$75) for unknown models", () => {
      expect(provider.computeCost("unknown-model-xyz", 1_000_000, 0)).toBe(15);
      expect(provider.computeCost("unknown-model-xyz", 0, 1_000_000)).toBe(75);
    });

    it("returns 0 for zero tokens", () => {
      expect(provider.computeCost("claude-sonnet-4-5", 0, 0)).toBe(0);
    });
  });

  it("does NOT import @anthropic-ai/claude-agent-sdk", async () => {
    // Structural check: the provider's module bundle should not pull in
    // the Agent SDK. This protects against accidental re-introduction
    // during Phase 1 — the architecture lock is single-pass completion,
    // not multi-turn tool-use. We verify by reading the source file and
    // grepping for the import.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const providerSource = readFileSync(
      join(here, "..", "..", "..", "src", "llm", "providers", "anthropic.ts"),
      "utf8",
    );
    // Check for actual import statements, not docstring mentions. The
    // docstring legitimately names the Agent SDK to document why we don't
    // depend on it; this assertion guards against accidental imports.
    expect(providerSource).not.toMatch(/^import .* from ["']@anthropic-ai\/claude-agent-sdk["']/m);
    expect(providerSource).not.toMatch(/^import .* from ["']@anthropic-ai\/claude-code["']/m);
  });
});

describe("CompletionOptions type", () => {
  it("accepts the documented option shape", () => {
    // Compile-time check via type assertion. If CompletionOptions drifts
    // away from the locked shape, this won't compile.
    const opts: CompletionOptions = {
      model: "claude-sonnet-4-5",
      systemPrompt: "be brief",
      maxTokens: 100,
      temperature: 0.5,
      stopSequences: ["END"],
      abortSignal: new AbortController().signal,
    };
    expect(opts.model).toBe("claude-sonnet-4-5");
  });
});
