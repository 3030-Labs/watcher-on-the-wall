/**
 * Unit tests for src/facts/extractor.ts.
 *
 * Mocks `runtimeAwareComplete` so the extractor's prompt + JSON parser
 * + cost-free gating are covered without touching a live LLM.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { defaultConfig, resolveConfigPaths } from "../../../src/daemon/config.js";
import { isExtractionActive, parseFactsResponse } from "../../../src/facts/extractor.js";

describe("isExtractionActive: deterministic per runtime + provider", () => {
  it("auto + cli → active", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    const r = isExtractionActive(config, "cli");
    expect(r.active).toBe(true);
    expect(r.reason).toContain("cli");
  });

  it("auto + ollama → active", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "ollama";
    const r = isExtractionActive(config, "api");
    expect(r.active).toBe(true);
    expect(r.reason).toContain("ollama");
  });

  it("auto + anthropic api → inactive (no force)", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "anthropic";
    const r = isExtractionActive(config, "api");
    expect(r.active).toBe(false);
    expect(r.reason).toContain("metered");
  });

  it("auto + anthropic + force_enabled → active", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "anthropic";
    config.fact_extraction.force_enabled = true;
    const r = isExtractionActive(config, "api");
    expect(r.active).toBe(true);
    expect(r.reason).toContain("force_enabled");
  });

  it("enabled=true → always active", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "openai";
    config.fact_extraction.enabled = true;
    expect(isExtractionActive(config, "api").active).toBe(true);
  });

  it("enabled=false → always inactive", () => {
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "ollama";
    config.fact_extraction.enabled = false;
    expect(isExtractionActive(config, "cli").active).toBe(false);
  });
});

describe("parseFactsResponse: tolerant JSON parsing", () => {
  it("parses a clean JSON response", () => {
    const text = JSON.stringify({
      facts: [
        {
          entity: "Photosynthesis",
          statement: "It converts light into glucose.",
          questions: ["What does photosynthesis do?", "How does it work?"],
        },
      ],
    });
    const facts = parseFactsResponse(text);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.entity).toBe("Photosynthesis");
    expect(facts[0]!.questions).toHaveLength(2);
  });

  it("strips markdown fences", () => {
    const text =
      "```json\n" +
      JSON.stringify({
        facts: [{ entity: "X", statement: "Y", questions: ["Q1"] }],
      }) +
      "\n```";
    const facts = parseFactsResponse(text);
    expect(facts).toHaveLength(1);
  });

  it("returns empty array on garbage input", () => {
    expect(parseFactsResponse("not json")).toEqual([]);
    expect(parseFactsResponse("")).toEqual([]);
    expect(parseFactsResponse("{not valid")).toEqual([]);
  });

  it("skips facts missing required fields", () => {
    const text = JSON.stringify({
      facts: [
        { entity: "ok", statement: "ok", questions: [] },
        { entity: "", statement: "missing entity" },
        { entity: "missing-statement" },
        { entity: "ok2", statement: "ok2", questions: ["q"] },
      ],
    });
    const facts = parseFactsResponse(text);
    expect(facts).toHaveLength(2);
    expect(facts.map((f) => f.entity)).toEqual(["ok", "ok2"]);
  });

  it("tolerates malformed questions field", () => {
    const text = JSON.stringify({
      facts: [{ entity: "x", statement: "y", questions: "not-an-array" }],
    });
    const facts = parseFactsResponse(text);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.questions).toEqual([]);
  });
});

describe("extractFactsFromPage: gating + LLM call", () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ran:false when extraction is gated off", async () => {
    vi.doMock("../../../src/llm/runtime-aware.js", () => ({
      runtimeAwareComplete: vi.fn().mockResolvedValue({ text: "", costUsd: 0 }),
    }));
    const { extractFactsFromPage } = await import("../../../src/facts/extractor.js");
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    config.llm.provider = "anthropic";
    const result = await extractFactsFromPage({
      config,
      runtimeMode: "api",
      wikiPageId: "wiki/concepts/x.md",
      pageBody: "some body",
      title: "X",
      costTracker: {
        logUsage: () => {},
      } as never,
    });
    expect(result.ran).toBe(false);
    expect(result.facts).toEqual([]);
    expect(result.skipReason).toContain("metered");
  });

  it("runs and parses LLM response when extraction is active", async () => {
    const mock = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        facts: [{ entity: "X", statement: "X is X.", questions: ["What is X?"] }],
      }),
      costUsd: 0,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 10,
      finishReason: "end_turn",
    });
    vi.doMock("../../../src/llm/runtime-aware.js", () => ({ runtimeAwareComplete: mock }));
    const { extractFactsFromPage } = await import("../../../src/facts/extractor.js");
    const config = resolveConfigPaths(defaultConfig(), "/tmp");
    let loggedOp: string | undefined;
    const result = await extractFactsFromPage({
      config,
      runtimeMode: "cli",
      wikiPageId: "wiki/concepts/x.md",
      pageBody: "body",
      title: "X",
      costTracker: {
        logUsage: (p: { operation: string }) => {
          loggedOp = p.operation;
        },
      } as never,
    });
    expect(result.ran).toBe(true);
    expect(result.facts).toHaveLength(1);
    expect(mock).toHaveBeenCalledOnce();
    expect(loggedOp).toBe("fact_extraction");
  });
});
