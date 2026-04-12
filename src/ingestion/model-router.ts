/**
 * Model router. Maps logical operation types ("ingest", "query", "lint",
 * "compound_eval") to concrete model IDs pulled from config, and exposes
 * per-model pricing for the cost tracker.
 *
 * Pricing numbers are USD per 1M tokens. They're used to convert usage
 * reports from the Anthropic SDK into dollar amounts. When a model ID is
 * unknown, we fall back to conservative defaults so the budget guardrails
 * still trip before we blow through real money.
 */
import { getLogger } from "../utils/logger.js";
import type { ModelId, OperationType, WotwConfig } from "../utils/types.js";

/** Price table in USD per 1M tokens. */
export interface ModelPricing {
  input: number;
  output: number;
}

/** Known Anthropic model pricing as of 2026. Adjust in a single place. */
export const PRICING: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-4-6": { input: 15, output: 75 },
  "claude-opus-4-5": { input: 15, output: 75 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5": { input: 1, output: 5 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
};

/** Conservative default used when we can't find a price entry. */
const DEFAULT_PRICING: ModelPricing = { input: 15, output: 75 };

export class ModelRouter {
  private readonly cfg: WotwConfig;

  constructor(cfg: WotwConfig) {
    this.cfg = cfg;
  }

  /** Resolve the model ID for a given operation type. */
  modelFor(op: OperationType | "compound_eval"): ModelId {
    switch (op) {
      case "ingest":
        return this.cfg.models.ingest;
      case "query":
        return this.cfg.models.query;
      case "lint":
        return this.cfg.models.lint;
      case "compound":
      case "compound_eval":
        return this.cfg.models.compound_eval;
      case "merge":
        return this.cfg.models.ingest;
      default:
        return this.cfg.models.ingest;
    }
  }

  /** Look up pricing for a model ID. Falls back to conservative defaults. */
  pricingFor(modelId: ModelId): ModelPricing {
    const p = PRICING[modelId];
    if (p) return p;
    getLogger("model-router").warn(
      { model: modelId },
      "unknown model — using Opus-tier pricing as fallback",
    );
    return DEFAULT_PRICING;
  }

  /** Convert usage tokens to USD cost for a given model. */
  computeCost(modelId: ModelId, inputTokens: number, outputTokens: number): number {
    const p = this.pricingFor(modelId);
    return (inputTokens * p.input + outputTokens * p.output) / 1_000_000;
  }
}
