/**
 * Unit tests for ModelRouter: operation→model mapping, pricing, and cost math.
 */
import { describe, expect, it } from "vitest";
import { ModelRouter, PRICING } from "../../src/ingestion/model-router.js";
import type { WotwConfig } from "../../src/utils/types.js";
import { defaultConfig } from "../../src/daemon/config.js";

function makeConfig(overrides: Partial<WotwConfig["models"]> = {}): WotwConfig {
  const cfg = defaultConfig();
  cfg.models = { ...cfg.models, ...overrides };
  return cfg;
}

describe("PRICING table", () => {
  it("contains expected Claude 4.x model entries", () => {
    expect(PRICING["claude-opus-4-6"]).toEqual({ input: 15, output: 75 });
    expect(PRICING["claude-sonnet-4-6"]).toEqual({ input: 3, output: 15 });
    expect(PRICING["claude-haiku-4-5"]).toEqual({ input: 1, output: 5 });
  });
});

describe("ModelRouter.modelFor", () => {
  it("resolves each operation to the configured model", () => {
    const router = new ModelRouter(
      makeConfig({
        ingest: "claude-haiku-4-5",
        query: "claude-sonnet-4-5",
        lint: "claude-sonnet-4-5",
        compound_eval: "claude-haiku-4-5",
      }),
    );
    expect(router.modelFor("ingest")).toBe("claude-haiku-4-5");
    expect(router.modelFor("query")).toBe("claude-sonnet-4-5");
    expect(router.modelFor("lint")).toBe("claude-sonnet-4-5");
    expect(router.modelFor("compound")).toBe("claude-haiku-4-5");
    expect(router.modelFor("compound_eval")).toBe("claude-haiku-4-5");
  });

  it("uses ingest model for merge", () => {
    const router = new ModelRouter(makeConfig({ ingest: "claude-opus-4-6" }));
    expect(router.modelFor("merge")).toBe("claude-opus-4-6");
  });
});

describe("ModelRouter.pricingFor", () => {
  it("returns exact pricing for known models", () => {
    const router = new ModelRouter(defaultConfig());
    expect(router.pricingFor("claude-haiku-4-5")).toEqual({ input: 1, output: 5 });
  });

  it("falls back to conservative defaults for unknown models", () => {
    const router = new ModelRouter(defaultConfig());
    const p = router.pricingFor("unknown-model-123");
    expect(p.input).toBe(15);
    expect(p.output).toBe(75);
  });
});

describe("ModelRouter.computeCost", () => {
  it("computes cost correctly for haiku", () => {
    const router = new ModelRouter(defaultConfig());
    // haiku: $1/M input, $5/M output
    // 1000 input tokens = $0.001
    // 500 output tokens = $0.0025
    const cost = router.computeCost("claude-haiku-4-5", 1000, 500);
    expect(cost).toBeCloseTo(0.0035, 10);
  });

  it("computes cost correctly for opus", () => {
    const router = new ModelRouter(defaultConfig());
    // opus: $15/M input, $75/M output
    // 2000 input tokens = $0.03
    // 1000 output tokens = $0.075
    const cost = router.computeCost("claude-opus-4-6", 2000, 1000);
    expect(cost).toBeCloseTo(0.105, 10);
  });

  it("handles zero tokens", () => {
    const router = new ModelRouter(defaultConfig());
    expect(router.computeCost("claude-haiku-4-5", 0, 0)).toBe(0);
  });

  it("uses conservative default for unknown model", () => {
    const router = new ModelRouter(defaultConfig());
    // default: $15/M input, $75/M output
    const cost = router.computeCost("mystery-model", 1000, 1000);
    expect(cost).toBeCloseTo(0.09, 10);
  });
});
