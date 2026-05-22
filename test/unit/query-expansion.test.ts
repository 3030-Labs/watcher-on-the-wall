/**
 * Tests for Feature 1: Query expansion via LLM.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/daemon/config.js";

// Mock the runtime-aware complete wrapper before importing the module
// under test. Post Phase 2, expandQuery dispatches through
// runtimeAwareComplete (API mode → AnthropicProvider; CLI mode →
// subprocess). The wrapper layer is the right mock boundary.
vi.mock("../../src/llm/runtime-aware.js", () => ({
  runtimeAwareComplete: vi.fn(),
}));

import { expandQuery } from "../../src/server/query-expansion.js";
import { runtimeAwareComplete } from "../../src/llm/runtime-aware.js";
import type { RuntimeAwareCompleteResult } from "../../src/llm/runtime-aware.js";
import { CostTracker } from "../../src/ingestion/cost-tracker.js";
import { ModelRouter } from "../../src/ingestion/model-router.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mockedInvoke = vi.mocked(runtimeAwareComplete);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-qe-"));
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function makeOpts(overrides: Partial<ReturnType<typeof defaultConfig>> = {}) {
  const dir = tmp();
  const config = {
    ...defaultConfig(),
    wiki_root: dir,
    ...overrides,
  };
  return {
    config,
    costTracker: new CostTracker({
      trackFile: join(dir, "cost.jsonl"),
      maxDailyUsd: 10,
      maxPerIngestUsd: 2,
      maxPerQueryUsd: 0.5,
    }),
    modelRouter: new ModelRouter(config),
    runtimeMode: "api" as const,
  };
}

function mockLlmResponse(text: string): RuntimeAwareCompleteResult {
  return {
    text,
    costUsd: 0.001,
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 200,
  };
}

describe("expandQuery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it("returns expanded query with LLM-provided synonyms", async () => {
    mockedInvoke.mockResolvedValueOnce(
      mockLlmResponse('["deployment", "release", "ship", "rollout"]'),
    );
    const result = await expandQuery("deploy", makeOpts());
    expect(result.expanded).toBe(true);
    expect(result.expansionTerms).toEqual(["deployment", "release", "ship", "rollout"]);
    expect(result.expandedQuery).toContain("deploy");
    expect(result.expandedQuery).toContain("deployment");
    expect(result.expandedQuery).toContain("rollout");
  });

  it("falls back to original query on garbage LLM response", async () => {
    mockedInvoke.mockResolvedValueOnce(mockLlmResponse("This is not JSON at all."));
    const result = await expandQuery("deploy", makeOpts());
    expect(result.expanded).toBe(false);
    expect(result.expandedQuery).toBe("deploy");
    expect(result.expansionTerms).toEqual([]);
  });

  it("falls back to original query on LLM error", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("LLM failed"));
    const result = await expandQuery("deploy", makeOpts());
    expect(result.expanded).toBe(false);
    expect(result.expandedQuery).toBe("deploy");
  });

  it("skips expansion when query.expand is false", async () => {
    const opts = makeOpts();
    opts.config.query.expand = false;
    const result = await expandQuery("deploy", opts);
    expect(result.expanded).toBe(false);
    expect(result.expandedQuery).toBe("deploy");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("handles JSON wrapped in markdown code fences", async () => {
    mockedInvoke.mockResolvedValueOnce(mockLlmResponse('```json\n["syn1", "syn2"]\n```'));
    const result = await expandQuery("test query", makeOpts());
    expect(result.expanded).toBe(true);
    expect(result.expansionTerms).toEqual(["syn1", "syn2"]);
  });

  it("filters out non-string entries from LLM response", async () => {
    mockedInvoke.mockResolvedValueOnce(mockLlmResponse('["valid", 123, null, "also valid", ""]'));
    const result = await expandQuery("test", makeOpts());
    expect(result.expanded).toBe(true);
    expect(result.expansionTerms).toEqual(["valid", "also valid"]);
  });
});
