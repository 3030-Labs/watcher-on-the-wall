/**
 * Unit tests for execution-mode resolver.
 *
 * The resolver is the daemon's gatekeeper for which Claude runtime to use:
 * the local CLI binary, the Agent SDK, or refusal-to-start. We exercise:
 *
 *   - findOnPath: returns null for a binary that doesn't exist
 *   - findApiKey: env var detection (set vs unset vs whitespace)
 *   - resolveExecutionMode: each of the four code paths (auto-cli, auto-api,
 *     explicit cli, explicit api) plus every refusal path with the right
 *     `code` field on the thrown error.
 *
 * We don't actually require a `claude` binary to be present — every test
 * uses a fake CLI name guaranteed not to exist on PATH.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionModeError,
  findApiKey,
  findOnPath,
  resolveExecutionMode,
} from "../../src/ingestion/execution-mode.js";
import type { WotwConfig } from "../../src/utils/types.js";

/** Build a minimal WotwConfig sufficient for the resolver. */
function configWith(
  execution: Partial<WotwConfig["execution"]>,
  models: Partial<WotwConfig["models"]> = {},
): WotwConfig {
  // We only need the `execution` and `models` blocks. The resolver doesn't
  // touch anything else, so we cast through `unknown` to avoid duplicating
  // the full config shape here.
  return {
    execution: {
      mode: "auto",
      cli_path: "definitely-not-a-real-binary-xyzzy",
      cli_model: "claude-sonnet-4-5",
      api_key_env: "WOTW_TEST_API_KEY_DOES_NOT_EXIST",
      ...execution,
    },
    models: {
      ingest: "claude-haiku-4-5",
      query: "claude-sonnet-4-5",
      compound_eval: "claude-haiku-4-5",
      ...models,
    },
  } as unknown as WotwConfig;
}

const TEST_KEY = "WOTW_TEST_API_KEY_FOR_EXECUTION_MODE";

describe("execution-mode: findOnPath", () => {
  it("returns null for a fake binary name", () => {
    expect(findOnPath("definitely-not-a-real-binary-xyzzy-2026")).toBeNull();
  });

  it("returns a path for a binary that exists on PATH", () => {
    // `node` is guaranteed available — the test is running under it.
    const result = findOnPath("node");
    expect(result).not.toBeNull();
    expect(typeof result).toBe("string");
    expect(result?.length ?? 0).toBeGreaterThan(0);
  });
});

describe("execution-mode: findApiKey", () => {
  beforeEach(() => {
    delete process.env[TEST_KEY];
  });
  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  it("returns the env var name when set to a non-empty value", () => {
    process.env[TEST_KEY] = "sk-ant-test-value";
    expect(findApiKey(TEST_KEY)).toBe(TEST_KEY);
  });

  it("returns null when the env var is unset", () => {
    expect(findApiKey(TEST_KEY)).toBeNull();
  });

  it("returns null when the env var is whitespace-only", () => {
    process.env[TEST_KEY] = "   \t  ";
    expect(findApiKey(TEST_KEY)).toBeNull();
  });
});

describe("execution-mode: resolveExecutionMode", () => {
  beforeEach(() => {
    delete process.env[TEST_KEY];
  });
  afterEach(() => {
    delete process.env[TEST_KEY];
  });

  it("auto: prefers CLI when binary is on PATH", () => {
    // Use `node` as the stand-in CLI — it always exists.
    const config = configWith({ mode: "auto", cli_path: "node", api_key_env: TEST_KEY });
    process.env[TEST_KEY] = "sk-ant-also-set"; // present, but CLI should win
    const result = resolveExecutionMode(config);
    expect(result.mode).toBe("cli");
    expect(result.configuredMode).toBe("auto");
    expect(result.cliPath).not.toBeNull();
    expect(result.apiKeyEnv).toBeNull();
    expect(result.description).toContain("CLI mode");
  });

  it("auto: falls back to API when CLI is missing but key is set", () => {
    process.env[TEST_KEY] = "sk-ant-test";
    const config = configWith({
      mode: "auto",
      cli_path: "definitely-not-a-real-binary-xyzzy-2026",
      api_key_env: TEST_KEY,
    });
    const result = resolveExecutionMode(config);
    expect(result.mode).toBe("api");
    expect(result.configuredMode).toBe("auto");
    expect(result.cliPath).toBeNull();
    expect(result.apiKeyEnv).toBe(TEST_KEY);
    expect(result.description).toContain("API mode");
  });

  it("auto: throws NO_RUNTIME_AVAILABLE when neither is present", () => {
    const config = configWith({
      mode: "auto",
      cli_path: "definitely-not-a-real-binary-xyzzy-2026",
      api_key_env: TEST_KEY,
    });
    try {
      resolveExecutionMode(config);
      throw new Error("expected resolveExecutionMode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionModeError);
      expect((err as ExecutionModeError).code).toBe("NO_RUNTIME_AVAILABLE");
    }
  });

  it("cli: throws CLI_BINARY_NOT_FOUND when binary is missing", () => {
    const config = configWith({
      mode: "cli",
      cli_path: "definitely-not-a-real-binary-xyzzy-2026",
    });
    try {
      resolveExecutionMode(config);
      throw new Error("expected resolveExecutionMode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionModeError);
      expect((err as ExecutionModeError).code).toBe("CLI_BINARY_NOT_FOUND");
    }
  });

  it("cli: succeeds when binary is on PATH", () => {
    const config = configWith({ mode: "cli", cli_path: "node" });
    const result = resolveExecutionMode(config);
    expect(result.mode).toBe("cli");
    expect(result.configuredMode).toBe("cli");
    expect(result.cliPath).not.toBeNull();
    expect(result.effectiveModelHint).toBe("claude-sonnet-4-5");
  });

  it("api: throws API_KEY_NOT_SET when env var is missing", () => {
    const config = configWith({ mode: "api", api_key_env: TEST_KEY });
    try {
      resolveExecutionMode(config);
      throw new Error("expected resolveExecutionMode to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(ExecutionModeError);
      expect((err as ExecutionModeError).code).toBe("API_KEY_NOT_SET");
    }
  });

  it("api: succeeds when key is set, ignoring CLI presence", () => {
    process.env[TEST_KEY] = "sk-ant-test";
    // Even with `node` as a stand-in CLI on PATH, mode=api must use API.
    const config = configWith({ mode: "api", cli_path: "node", api_key_env: TEST_KEY });
    const result = resolveExecutionMode(config);
    expect(result.mode).toBe("api");
    expect(result.configuredMode).toBe("api");
    expect(result.cliPath).toBeNull();
    expect(result.apiKeyEnv).toBe(TEST_KEY);
    expect(result.effectiveModelHint).toContain("model-router");
  });
});
