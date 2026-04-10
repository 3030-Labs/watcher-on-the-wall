/**
 * Execution mode detection. Resolves the configured {@link ExecutionMode}
 * ("auto" | "cli" | "api") into a concrete {@link RuntimeMode} ("cli" | "api")
 * at daemon startup.
 *
 * Rules:
 *   - mode=auto: prefer the `claude` CLI binary on PATH. If absent, fall back
 *     to the Agent SDK iff `ANTHROPIC_API_KEY` (or the configured env var) is
 *     set. If neither is available, refuse to start.
 *   - mode=cli: require the CLI binary on PATH; refuse to start if missing.
 *   - mode=api: require the API key env var to be set; refuse to start if
 *     missing.
 *
 * The detection is synchronous and cheap: one `which`/`where` invocation and
 * one env lookup. It must be called exactly once, during daemon init, so the
 * resolved mode can be logged prominently.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import type { ExecutionMode, RuntimeMode, WotwConfig } from "../utils/types.js";

/** Summary of a successful resolution. */
export interface ResolvedExecutionMode {
  /** Concrete runtime to use. */
  mode: RuntimeMode;
  /** Configured mode that produced this result. */
  configuredMode: ExecutionMode;
  /** Absolute path to the `claude` binary, if CLI mode was resolved. */
  cliPath: string | null;
  /** Name of the env var that supplied the API key, if API mode was resolved. */
  apiKeyEnv: string | null;
  /** Model identifier that will be used (cli_model in CLI mode, router in API mode). */
  effectiveModelHint: string;
  /** One-line human-readable summary, suitable for logging or CLI output. */
  description: string;
}

/**
 * Error thrown when the daemon cannot resolve a usable runtime mode.
 * Intentionally a subclass of Error with a `.code` field so callers can
 * surface a clean exit.
 */
export class ExecutionModeError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ExecutionModeError";
    this.code = code;
  }
}

/**
 * Look up the absolute path of a binary on PATH. Returns null if not found.
 * Uses `which` on Unix and `where` on Windows. Safe to call on WSL — the
 * Linux `which` is used there since WSL reports `platform() === 'linux'`.
 */
export function findOnPath(binary: string): string | null {
  // `command -v` would be slightly more portable on Unix, but it is a shell
  // builtin and spawnSync won't invoke a shell. `which` is universally
  // available on macOS, Linux, and WSL; `where` is the Windows equivalent.
  const prog = platform() === "win32" ? "where" : "which";
  try {
    const result = spawnSync(prog, [binary], { encoding: "utf8" });
    if (result.status !== 0) return null;
    const stdout = result.stdout.trim();
    if (!stdout) return null;
    // `where` may list multiple matches; take the first line.
    const first = stdout.split(/\r?\n/)[0]?.trim();
    return first && first.length > 0 ? first : null;
  } catch {
    return null;
  }
}

/**
 * Inspect the environment for an API key under the configured env var name.
 * Returns the var name if set (non-empty), null otherwise.
 */
export function findApiKey(envVarName: string): string | null {
  const value = process.env[envVarName];
  if (value && value.trim().length > 0) return envVarName;
  return null;
}

/**
 * Resolve {@link WotwConfig.execution} into a concrete {@link RuntimeMode}.
 * Throws {@link ExecutionModeError} with a precise reason if neither runtime
 * is available.
 */
export function resolveExecutionMode(config: WotwConfig): ResolvedExecutionMode {
  const { mode, cli_path: cliPath, cli_model: cliModel, api_key_env: apiKeyEnv } = config.execution;

  const detectCli = (): string | null => findOnPath(cliPath);
  const detectKey = (): string | null => findApiKey(apiKeyEnv);

  if (mode === "cli") {
    const path = detectCli();
    if (!path) {
      throw new ExecutionModeError(
        `execution.mode is 'cli' but the '${cliPath}' binary was not found on PATH. ` +
          "Install Claude Code CLI (https://docs.claude.com/claude-code) or set execution.mode to 'api'.",
        "CLI_BINARY_NOT_FOUND",
      );
    }
    return {
      mode: "cli",
      configuredMode: "cli",
      cliPath: path,
      apiKeyEnv: null,
      effectiveModelHint: cliModel,
      description: `CLI mode: using claude binary at ${path}, model ${cliModel}, zero marginal cost (subscription-covered)`,
    };
  }

  if (mode === "api") {
    const keyEnv = detectKey();
    if (!keyEnv) {
      throw new ExecutionModeError(
        `execution.mode is 'api' but ${apiKeyEnv} is not set. ` +
          "Set the env var or change execution.mode to 'cli'/'auto'.",
        "API_KEY_NOT_SET",
      );
    }
    return {
      mode: "api",
      configuredMode: "api",
      cliPath: null,
      apiKeyEnv: keyEnv,
      effectiveModelHint: `model-router (ingest=${config.models.ingest}, query=${config.models.query})`,
      description: `API mode: using Agent SDK with ${keyEnv}, model routing enabled (per-token billing)`,
    };
  }

  // mode === "auto"
  const cli = detectCli();
  if (cli) {
    return {
      mode: "cli",
      configuredMode: "auto",
      cliPath: cli,
      apiKeyEnv: null,
      effectiveModelHint: cliModel,
      description: `CLI mode (auto-detected): using claude binary at ${cli}, model ${cliModel}, zero marginal cost (subscription-covered)`,
    };
  }
  const keyEnv = detectKey();
  if (keyEnv) {
    return {
      mode: "api",
      configuredMode: "auto",
      cliPath: null,
      apiKeyEnv: keyEnv,
      effectiveModelHint: `model-router (ingest=${config.models.ingest}, query=${config.models.query})`,
      description: `API mode (auto-detected): using Agent SDK with ${keyEnv}, model routing enabled (per-token billing)`,
    };
  }
  throw new ExecutionModeError(
    `No '${cliPath}' binary on PATH and no ${apiKeyEnv} env var set. ` +
      "Install Claude Code CLI (https://docs.claude.com/claude-code) or set an API key to run watcher-on-the-wall.",
    "NO_RUNTIME_AVAILABLE",
  );
}
