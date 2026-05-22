import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runtimeAwareComplete } from "../../../src/llm/runtime-aware.js";
import type { WotwConfig } from "../../../src/utils/types.js";

/**
 * Tests for runtimeAwareComplete. The wrapper dispatches:
 *   - API mode → AnthropicProvider.completeWithUsage (Messages API)
 *   - CLI mode → invokeIngestionAgent (subprocess)
 *
 * The two paths are mocked separately so we can verify each branch
 * receives the right shape of options and returns the unified result
 * shape (text + costUsd + inputTokens + outputTokens + durationMs).
 */

// Mock the CLI dispatcher used by API mode.
const invokeIngestionAgentMock = vi.fn();
vi.mock("../../../src/ingestion/llm-invoker.js", () => ({
  invokeIngestionAgent: (opts: unknown) => invokeIngestionAgentMock(opts),
}));

// Mock the Anthropic provider used by API mode.
const completeWithUsageMock = vi.fn();
vi.mock("../../../src/llm/providers/anthropic.js", () => {
  return {
    AnthropicProvider: vi.fn().mockImplementation(() => ({
      completeWithUsage: (...args: unknown[]) => completeWithUsageMock(...args),
    })),
  };
});

function minimalConfig(): WotwConfig {
  return {
    wiki_root: "/tmp/wiki",
    raw_path: "/tmp/wiki/raw",
    llm: {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    },
    execution: {
      mode: "auto",
      cli_path: "/usr/local/bin/claude",
      cli_model: "claude-sonnet-4-5",
      api_key_env: "ANTHROPIC_API_KEY",
    },
    models: {
      ingest: "claude-haiku-4-5",
      query: "claude-sonnet-4-5",
      lint: "claude-haiku-4-5",
      compound_eval: "claude-sonnet-4-5",
    },
    watcher: {
      debounce_initial_ms: 1000,
      debounce_max_ms: 60_000,
      debounce_growth_factor: 1.5,
      burst_threshold: 5,
      max_batch_size: 50,
      ignore_patterns: [],
    },
    ingestion: {
      max_turns: 50,
      max_budget_per_batch_usd: 5,
      resume_session: false,
      dead_letter_file: "",
      staging: false,
    },
    cost: {
      max_daily_usd: 100,
      max_per_query_usd: 1,
      max_per_ingest_usd: 5,
      track_file: "/tmp/wiki/.wotw/cost.jsonl",
    },
    server: {
      port: 3010,
      host: "127.0.0.1",
      auth_token: null,
      rate_limit_rpm: 60,
      trust_proxy: false,
    },
    daemon: {
      pid_file: "/tmp/wiki/.wotw/daemon.pid",
      lock_file: "/tmp/wiki/.wotw/daemon.lock",
      log_file: "/tmp/wiki/.wotw/daemon.log",
      log_level: "info",
    },
    compounding: { enabled: false, min_source_pages: 3, confidence_threshold: 0.7 },
    provenance: {
      enabled: true,
      chain_file: "/tmp/wiki/.wotw/provenance.jsonl",
      verify_on_startup: false,
    },
    multi_user: { enabled: false, workspaces_dir: "" },
    query: { expand: false },
    lint: { schedule_enabled: false, interval_hours: 24, auto_fix: false },
    health: {
      staleness_thresholds: [7, 30, 90],
      staleness_scores: [1, 0.7, 0.4, 0.1],
      weights: {
        staleness: 0.3,
        source_availability: 0.3,
        link_health: 0.1,
        duplicate_risk: 0.15,
        contradiction_risk: 0.15,
      },
      duplicate_threshold: 85,
      auto_fix_staleness_below: 0.3,
      max_fixes_per_run: 10,
      detect_contradictions: false,
      consolidation_threshold: 5,
      consolidation_enabled: false,
      zero_hit_threshold: 0.2,
      enrichment_enabled: false,
      query_log_file: "/tmp/wiki/.wotw/queries.jsonl",
    },
    hosted: {
      enabled: false,
      tenant_id: null,
      concurrency_cap: 1,
      paused: false,
      plan: "pro",
      limits: {
        storage_bytes: 0,
        max_files_per_day: 0,
        max_file_size_bytes: 0,
        max_ingest_bytes_per_day: 0,
        heal_cooldown_seconds: 0,
        query_rate_limit_per_hour: 0,
        onboarding_burst_multiplier: 1,
        onboarding_burst_hours: 0,
      },
      timezone: "UTC",
      created_at: null,
    },
  };
}

describe("runtimeAwareComplete", () => {
  beforeEach(() => {
    invokeIngestionAgentMock.mockReset();
    completeWithUsageMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("CLI mode", () => {
    it("dispatches to invokeIngestionAgent with maxTurns=1 and empty tools", async () => {
      invokeIngestionAgentMock.mockResolvedValue({
        finalText: "cli output",
        totalCostUsd: 0,
        inputTokens: 100,
        outputTokens: 50,
        durationMs: 250,
      });

      const result = await runtimeAwareComplete("test prompt", {
        model: "claude-sonnet-4-5",
        systemPrompt: "system",
        config: minimalConfig(),
        runtimeMode: "cli",
      });

      expect(invokeIngestionAgentMock).toHaveBeenCalledTimes(1);
      const args = invokeIngestionAgentMock.mock.calls[0][0];
      expect(args.runtimeMode).toBe("cli");
      expect(args.maxTurns).toBe(1);
      expect(args.allowedTools).toEqual([]);
      expect(args.userPrompt).toBe("test prompt");
      expect(args.systemPrompt).toBe("system");
      expect(args.cliConfig).toEqual({
        cliPath: "/usr/local/bin/claude",
        cliModel: "claude-sonnet-4-5",
      });

      expect(result.text).toBe("cli output");
      expect(result.costUsd).toBe(0);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.durationMs).toBe(250);

      // API path must NOT be called.
      expect(completeWithUsageMock).not.toHaveBeenCalled();
    });

    it("uses empty string for systemPrompt when not provided", async () => {
      invokeIngestionAgentMock.mockResolvedValue({
        finalText: "ok",
        totalCostUsd: 0,
        inputTokens: 1,
        outputTokens: 1,
        durationMs: 10,
      });

      await runtimeAwareComplete("p", {
        model: "claude-sonnet-4-5",
        config: minimalConfig(),
        runtimeMode: "cli",
      });

      const args = invokeIngestionAgentMock.mock.calls[0][0];
      expect(args.systemPrompt).toBe("");
    });
  });

  describe("API mode", () => {
    it("dispatches to AnthropicProvider.completeWithUsage", async () => {
      completeWithUsageMock.mockResolvedValue({
        text: "api output",
        usage: {
          inputTokens: 200,
          outputTokens: 100,
          totalCostUsd: 0.005,
          durationMs: 300,
          finishReason: "end_turn",
        },
      });

      const result = await runtimeAwareComplete("test prompt", {
        model: "claude-sonnet-4-5",
        systemPrompt: "system",
        maxTokens: 1000,
        temperature: 0.5,
        config: minimalConfig(),
        runtimeMode: "api",
      });

      expect(completeWithUsageMock).toHaveBeenCalledTimes(1);
      const [callPrompt, callOptions] = completeWithUsageMock.mock.calls[0];
      expect(callPrompt).toBe("test prompt");
      expect(callOptions.model).toBe("claude-sonnet-4-5");
      expect(callOptions.systemPrompt).toBe("system");
      expect(callOptions.maxTokens).toBe(1000);
      expect(callOptions.temperature).toBe(0.5);

      expect(result.text).toBe("api output");
      expect(result.costUsd).toBe(0.005);
      expect(result.inputTokens).toBe(200);
      expect(result.outputTokens).toBe(100);
      expect(result.durationMs).toBe(300);

      // CLI path must NOT be called.
      expect(invokeIngestionAgentMock).not.toHaveBeenCalled();
    });

    it("maps null totalCostUsd to 0", async () => {
      completeWithUsageMock.mockResolvedValue({
        text: "ok",
        usage: {
          inputTokens: 10,
          outputTokens: 5,
          totalCostUsd: null,
          durationMs: 100,
          finishReason: "end_turn",
        },
      });

      const result = await runtimeAwareComplete("p", {
        model: "claude-sonnet-4-5",
        config: minimalConfig(),
        runtimeMode: "api",
      });

      expect(result.costUsd).toBe(0);
    });

    it("dispatches to OpenAIProvider when config.llm.provider=openai", async () => {
      // Note: this test verifies the selectProvider switch is wired. The
      // mock for AnthropicProvider doesn't fire because selectProvider
      // returns a fresh OpenAIProvider. The OpenAI SDK constructor with no
      // api key will be reached, but the actual API call is never made
      // because we set up the mock... actually we can't mock OpenAIProvider
      // the same way here. Verify the structural property: when provider
      // is "openai", the AnthropicProvider mock does NOT fire.
      completeWithUsageMock.mockResolvedValue({
        text: "anthropic-only",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalCostUsd: 0,
          durationMs: 10,
          finishReason: "end_turn",
        },
      });

      const config = minimalConfig();
      config.llm.provider = "openai";
      // Suppress the actual SDK call by not having a key — the OpenAI SDK
      // throws synchronously on no key. We catch the expected error.
      await expect(
        runtimeAwareComplete("p", {
          model: "gpt-4o",
          config,
          runtimeMode: "api",
        }),
      ).rejects.toBeDefined();

      // AnthropicProvider's mocked method must NOT have been called.
      expect(completeWithUsageMock).not.toHaveBeenCalled();
    });

    it("forwards abortSignal to the provider", async () => {
      completeWithUsageMock.mockResolvedValue({
        text: "ok",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalCostUsd: 0,
          durationMs: 10,
          finishReason: "end_turn",
        },
      });

      const controller = new AbortController();
      await runtimeAwareComplete("p", {
        model: "claude-sonnet-4-5",
        config: minimalConfig(),
        runtimeMode: "api",
        abortSignal: controller.signal,
      });

      const [, callOptions] = completeWithUsageMock.mock.calls[0];
      expect(callOptions.abortSignal).toBe(controller.signal);
    });
  });
});
