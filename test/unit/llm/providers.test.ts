/**
 * Unit tests for the OpenAI / Gemini / Ollama providers. Each verifies:
 *   - LLMProvider interface contract (name, supportsTools, methods)
 *   - Response parsing into the unified CompletionResult shape
 *   - Stop reason normalization
 *   - Cost computation against the per-provider PRICING table
 *
 * SDK clients are mocked via dependency injection (config.client / fetchImpl).
 */
import { describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../../src/llm/providers/openai.js";
import { GeminiProvider } from "../../../src/llm/providers/gemini.js";
import { OllamaProvider } from "../../../src/llm/providers/ollama.js";

// ============================================================================
// OpenAIProvider
// ============================================================================

interface OpenAIMockClient {
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  client: {
    chat: { completions: { create: ReturnType<typeof vi.fn> } };
    models: { list: ReturnType<typeof vi.fn> };
  };
}

describe("OpenAIProvider", () => {
  function makeMockClient(response: unknown, modelsListResponse?: unknown): OpenAIMockClient {
    const create = vi.fn().mockResolvedValue(response);
    const list = vi.fn().mockResolvedValue(modelsListResponse ?? { data: [] });
    return {
      create,
      list,
      client: {
        chat: { completions: { create } },
        models: { list },
      },
    };
  }

  it("has name='openai' and supportsTools=true", () => {
    const provider = new OpenAIProvider({ apiKey: "test" });
    expect(provider.name).toBe("openai");
    expect(provider.supportsTools).toBe(true);
  });

  it("complete() returns the choice message content", async () => {
    const mock = makeMockClient({
      choices: [{ message: { content: "hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    const text = await provider.complete("prompt", { model: "gpt-4o" });
    expect(text).toBe("hello world");
  });

  it("completeWithUsage returns cost computed against PRICING", async () => {
    const mock = makeMockClient({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1_000_000, completion_tokens: 1_000_000 },
    });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    const result = await provider.completeWithUsage("p", { model: "gpt-4o" });
    // gpt-4o: input $2.50/M + output $10/M = $12.50 for 1M each
    expect(result.usage.totalCostUsd).toBeCloseTo(12.5, 4);
    expect(result.usage.finishReason).toBe("end_turn");
  });

  it("normalizes finish_reason 'length' to 'max_tokens'", async () => {
    const mock = makeMockClient({
      choices: [{ message: { content: "x" }, finish_reason: "length" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    const result = await provider.completeWithUsage("p", { model: "gpt-4o" });
    expect(result.usage.finishReason).toBe("max_tokens");
  });

  it("normalizes unknown finish_reason to 'error'", async () => {
    const mock = makeMockClient({
      choices: [{ message: { content: "x" }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    const result = await provider.completeWithUsage("p", { model: "gpt-4o" });
    expect(result.usage.finishReason).toBe("error");
  });

  it("forwards systemPrompt as system-role message", async () => {
    const mock = makeMockClient({
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    await provider.complete("user prompt", {
      model: "gpt-4o",
      systemPrompt: "be brief",
    });
    const args = mock.create.mock.calls[0][0];
    expect(args.messages[0]).toEqual({ role: "system", content: "be brief" });
    expect(args.messages[1]).toEqual({ role: "user", content: "user prompt" });
  });

  it("validateConnection returns valid:true on successful models.list", async () => {
    const mock = makeMockClient({ choices: [], usage: {} }, { data: [{ id: "gpt-4o" }] });
    const provider = new OpenAIProvider({
      client: mock.client as never,
    });
    const result = await provider.validateConnection();
    expect(result.valid).toBe(true);
  });

  it("validateConnection returns valid:false on error", async () => {
    const list = vi.fn().mockRejectedValue(new Error("401"));
    const provider = new OpenAIProvider({
      client: {
        chat: { completions: { create: vi.fn() } },
        models: { list },
      } as never,
    });
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/401/);
  });

  it("computeCost falls back to gpt-4o pricing for unknown models", () => {
    const provider = new OpenAIProvider({ apiKey: "test" });
    expect(provider.computeCost("unknown-model", 1_000_000, 0)).toBeCloseTo(2.5, 4);
    expect(provider.computeCost("unknown-model", 0, 1_000_000)).toBe(10);
  });

  it("computeCost: gpt-4o-mini is much cheaper", () => {
    const provider = new OpenAIProvider({ apiKey: "test" });
    expect(provider.computeCost("gpt-4o-mini", 1_000_000, 0)).toBeCloseTo(0.15, 4);
    expect(provider.computeCost("gpt-4o-mini", 0, 1_000_000)).toBeCloseTo(0.6, 4);
  });
});

// ============================================================================
// GeminiProvider
// ============================================================================

interface GeminiMockClient {
  generateContent: ReturnType<typeof vi.fn>;
  getGenerativeModel: ReturnType<typeof vi.fn>;
  client: { getGenerativeModel: ReturnType<typeof vi.fn> };
}

describe("GeminiProvider", () => {
  function makeMockClient(generateContentResponse: unknown): GeminiMockClient {
    const generateContent = vi.fn().mockResolvedValue({ response: generateContentResponse });
    const getGenerativeModel = vi.fn().mockReturnValue({ generateContent });
    return {
      generateContent,
      getGenerativeModel,
      client: { getGenerativeModel },
    };
  }

  it("has name='gemini' and supportsTools=true", () => {
    const provider = new GeminiProvider({ apiKey: "test" });
    expect(provider.name).toBe("gemini");
    expect(provider.supportsTools).toBe(true);
  });

  it("complete() concatenates text parts", async () => {
    const mock = makeMockClient({
      candidates: [
        {
          content: {
            parts: [{ text: "hello " }, { text: "world" }],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    });
    const provider = new GeminiProvider({
      client: mock.client as never,
    });
    const text = await provider.complete("p", { model: "gemini-2.0-pro" });
    expect(text).toBe("hello world");
  });

  it("normalizes STOP/MAX_TOKENS/SAFETY", async () => {
    for (const [raw, expected] of [
      ["STOP", "end_turn"],
      ["MAX_TOKENS", "max_tokens"],
      ["SAFETY", "error"],
      ["RECITATION", "error"],
      [undefined, "error"],
    ] as const) {
      const mock = makeMockClient({
        candidates: [{ content: { parts: [{ text: "x" }] }, finishReason: raw }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
      const p = new GeminiProvider({
        client: mock.client as never,
      });
      const result = await p.completeWithUsage("p", { model: "gemini-2.0-pro" });
      expect(result.usage.finishReason).toBe(expected);
    }
  });

  it("computeCost: gemini-2.0-flash cheap, gemini-2.0-pro mid", () => {
    const provider = new GeminiProvider({ apiKey: "test" });
    expect(provider.computeCost("gemini-2.0-flash", 1_000_000, 0)).toBeCloseTo(0.075, 4);
    expect(provider.computeCost("gemini-2.0-pro", 1_000_000, 0)).toBeCloseTo(1.25, 4);
  });

  it("computeCost falls back to gemini-2.0-pro pricing for unknown models", () => {
    const provider = new GeminiProvider({ apiKey: "test" });
    expect(provider.computeCost("unknown-gemini", 1_000_000, 0)).toBeCloseTo(1.25, 4);
  });

  it("does NOT use strict safety by default (relaxed for technical content)", async () => {
    const mock = makeMockClient({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider({
      client: mock.client as never,
    });
    await provider.complete("p", { model: "gemini-2.0-pro" });
    const callArgs = mock.getGenerativeModel.mock.calls[0][0];
    expect(callArgs.safetySettings).toBeDefined();
    expect(callArgs.safetySettings.length).toBeGreaterThan(0);
  });

  it("uses strict safety when strictSafety=true (no safetySettings override)", async () => {
    const mock = makeMockClient({
      candidates: [{ content: { parts: [{ text: "ok" }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
    });
    const provider = new GeminiProvider({
      client: mock.client as never,
      strictSafety: true,
    });
    await provider.complete("p", { model: "gemini-2.0-pro" });
    const callArgs = mock.getGenerativeModel.mock.calls[0][0];
    expect(callArgs.safetySettings).toBeUndefined();
  });
});

// ============================================================================
// OllamaProvider
// ============================================================================

describe("OllamaProvider", () => {
  function makeMockFetch(chatResponse: unknown, tagsResponse?: unknown): ReturnType<typeof vi.fn> {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/api/chat")) {
        return {
          ok: true,
          status: 200,
          json: async () => chatResponse,
          text: async () => "",
        } as Response;
      }
      if (url.endsWith("/api/tags")) {
        return {
          ok: true,
          status: 200,
          json: async () => tagsResponse ?? { models: [] },
          text: async () => "",
        } as Response;
      }
      return {
        ok: false,
        status: 404,
        json: async () => ({}),
        text: async () => "not found",
      } as Response;
    });
    return fetchImpl;
  }

  it("has name='ollama' and supportsTools=false", () => {
    const provider = new OllamaProvider();
    expect(provider.name).toBe("ollama");
    expect(provider.supportsTools).toBe(false);
  });

  it("default baseURL is localhost:11434", async () => {
    const fetchImpl = makeMockFetch({
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 5,
      eval_count: 3,
      done_reason: "stop",
    });
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    await provider.complete("p", { model: "llama3.3" });
    const url = (fetchImpl.mock.calls[0] as unknown as [string, unknown])[0];
    expect(url).toBe("http://localhost:11434/api/chat");
  });

  it("respects custom baseURL", async () => {
    const fetchImpl = makeMockFetch({
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 1,
      eval_count: 1,
      done_reason: "stop",
    });
    const provider = new OllamaProvider({
      baseURL: "http://my-server:9999",
      fetchImpl: fetchImpl as never,
    });
    await provider.complete("p", { model: "llama3.3" });
    const url = (fetchImpl.mock.calls[0] as unknown as [string, unknown])[0];
    expect(url).toBe("http://my-server:9999/api/chat");
  });

  it("complete() returns the message content", async () => {
    const fetchImpl = makeMockFetch({
      message: { role: "assistant", content: "hello local" },
      prompt_eval_count: 10,
      eval_count: 5,
      done_reason: "stop",
    });
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    const text = await provider.complete("p", { model: "llama3.3" });
    expect(text).toBe("hello local");
  });

  it("totalCostUsd is always null (local inference)", async () => {
    const fetchImpl = makeMockFetch({
      message: { role: "assistant", content: "x" },
      prompt_eval_count: 100,
      eval_count: 50,
      done_reason: "stop",
    });
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    const result = await provider.completeWithUsage("p", { model: "llama3.3" });
    expect(result.usage.totalCostUsd).toBeNull();
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
  });

  it("normalizes done_reason: stop/length/other → end_turn/max_tokens/error", async () => {
    for (const [raw, expected] of [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["unknown", "error"],
      [undefined, "error"],
    ] as const) {
      const fetchImpl = makeMockFetch({
        message: { role: "assistant", content: "x" },
        prompt_eval_count: 1,
        eval_count: 1,
        done_reason: raw,
      });
      const p = new OllamaProvider({ fetchImpl: fetchImpl as never });
      const result = await p.completeWithUsage("p", { model: "llama3.3" });
      expect(result.usage.finishReason).toBe(expected);
    }
  });

  it("forwards systemPrompt + maxTokens + temperature + stop", async () => {
    const fetchImpl = makeMockFetch({
      message: { role: "assistant", content: "ok" },
      prompt_eval_count: 1,
      eval_count: 1,
      done_reason: "stop",
    });
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    await provider.complete("user msg", {
      model: "llama3.3",
      systemPrompt: "be terse",
      maxTokens: 100,
      temperature: 0.4,
      stopSequences: ["END"],
    });
    const body = JSON.parse(
      (fetchImpl.mock.calls[0] as unknown as [string, { body: string }])[1].body,
    );
    expect(body.messages[0]).toEqual({ role: "system", content: "be terse" });
    expect(body.messages[1]).toEqual({ role: "user", content: "user msg" });
    expect(body.options.num_predict).toBe(100);
    expect(body.options.temperature).toBe(0.4);
    expect(body.options.stop).toEqual(["END"]);
    expect(body.stream).toBe(false);
  });

  it("validateConnection: hits /api/tags", async () => {
    const fetchImpl = makeMockFetch(
      { message: { content: "" }, prompt_eval_count: 0, eval_count: 0, done_reason: "stop" },
      { models: [{ name: "llama3.3" }] },
    );
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    const result = await provider.validateConnection();
    expect(result.valid).toBe(true);
  });

  it("validateConnection: returns valid:false on fetch error", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    const result = await provider.validateConnection();
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/ECONNREFUSED/);
  });

  it("listModels returns names from /api/tags", async () => {
    const fetchImpl = makeMockFetch(
      { message: { content: "" }, prompt_eval_count: 0, eval_count: 0, done_reason: "stop" },
      { models: [{ name: "llama3.3:70b" }, { name: "mistral-nemo" }] },
    );
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    const models = await provider.listModels();
    expect(models).toEqual(["llama3.3:70b", "mistral-nemo"]);
  });

  it("throws on chat HTTP error", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: async () => "internal error",
    }));
    const provider = new OllamaProvider({ fetchImpl: fetchImpl as never });
    await expect(provider.complete("p", { model: "llama3.3" })).rejects.toThrow(/500/);
  });
});
