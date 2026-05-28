/**
 * Actionable error class for the 10 user-facing unhappy paths surfaced
 * by PASS-023 (public-launch readiness). Each instance carries:
 *
 * - a stable `code` for programmatic handling + log indexing
 * - a one-line `summary` for the top of the rendered error
 * - a `cause` chain for diagnostics
 * - a `suggestions` array of concrete next steps the user can take
 *
 * The CLI's top-level error handler renders these as a structured block
 * to stderr; the daemon's internal logger captures the same fields as
 * structured JSON. Stack traces are suppressed unless `WOTW_DEBUG=1`.
 */
export type ActionableErrorCode =
  | "MISSING_VAULT_PATH"
  | "CONFIG_PARSE_ERROR"
  | "NATIVE_BINDING_LOAD_FAILURE"
  | "INVALID_API_KEY"
  | "RATE_LIMITED"
  | "WIKI_DIR_PERMISSION_DENIED"
  | "VAULT_FILE_LOCKED"
  | "PORT_IN_USE"
  | "DAEMON_ALREADY_RUNNING"
  | "INIT_TARGET_NOT_EMPTY";

export interface ActionableErrorOptions {
  code: ActionableErrorCode;
  summary: string;
  suggestions: readonly string[];
  cause?: unknown;
  docs?: string;
}

export class ActionableError extends Error {
  readonly code: ActionableErrorCode;
  readonly summary: string;
  readonly suggestions: readonly string[];
  readonly docs?: string;

  constructor(opts: ActionableErrorOptions) {
    const lines: string[] = [opts.summary];
    if (opts.suggestions.length > 0) {
      lines.push("", "What to try:");
      for (const suggestion of opts.suggestions) {
        lines.push(`  - ${suggestion}`);
      }
    }
    if (opts.docs) {
      lines.push("", `Docs: ${opts.docs}`);
    }
    super(lines.join("\n"));
    this.name = "ActionableError";
    this.code = opts.code;
    this.summary = opts.summary;
    this.suggestions = opts.suggestions;
    this.docs = opts.docs;
    if (opts.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export function isActionableError(e: unknown): e is ActionableError {
  return e instanceof ActionableError;
}

/**
 * Heuristic detection of native-binding load failures. better-sqlite3
 * (and other N-API addons) surface very platform-specific error
 * messages; this matcher captures the common shapes.
 */
export function looksLikeNativeBindingFailure(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return (
    /Cannot find module .*\.node/i.test(msg) ||
    /could not load the bindings file/i.test(msg) ||
    /better.sqlite3.*\.node.*was compiled against/i.test(msg) ||
    /NODE_MODULE_VERSION/i.test(msg) ||
    /ERR_DLOPEN_FAILED/i.test(msg) ||
    /libstdc\+\+.*GLIBCXX/i.test(msg) ||
    /Symbol not found.*sqlite3/i.test(msg) ||
    /image not found/i.test(msg)
  );
}

/**
 * Heuristic detection of EACCES / EPERM errors from filesystem APIs.
 */
export function looksLikePermissionDenied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  const code = e instanceof Error ? (e as { code?: string }).code : undefined;
  return code === "EACCES" || code === "EPERM" || /EACCES|EPERM/i.test(msg);
}

/**
 * Heuristic detection of file-lock contention errors. Obsidian holds
 * EBUSY/ETXTBSY on macOS, an undocumented lock state on Windows, and
 * EAGAIN on Linux when another process holds an exclusive lock.
 */
export function looksLikeFileLock(e: unknown): boolean {
  const code = e instanceof Error ? (e as { code?: string }).code : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  return (
    code === "EBUSY" ||
    code === "ETXTBSY" ||
    code === "EAGAIN" ||
    /EBUSY|ETXTBSY|EAGAIN|file is locked/i.test(msg)
  );
}

/**
 * Heuristic detection of port-in-use binding failures. listen() rejects
 * with EADDRINUSE on every supported platform.
 */
export function looksLikePortInUse(e: unknown): boolean {
  const code = e instanceof Error ? (e as { code?: string }).code : undefined;
  const msg = e instanceof Error ? e.message : String(e);
  return code === "EADDRINUSE" || /EADDRINUSE/i.test(msg);
}

/**
 * Build an ActionableError for the OBSIDIAN_VAULT_PATH-missing path
 * (item 1 of the PASS-023 error audit).
 */
export function missingVaultPathError(): ActionableError {
  return new ActionableError({
    code: "MISSING_VAULT_PATH",
    summary: "No Obsidian vault path was provided and none could be auto-detected.",
    suggestions: [
      "Run `wotw init` and pick a vault interactively.",
      "Pass `--path /path/to/vault` to point at a specific directory.",
      "Set OBSIDIAN_VAULT_PATH in your shell environment to a vault root.",
      "Install Obsidian and open at least one vault to register a default.",
    ],
    docs: "docs/init-walkthrough.md",
  });
}

/**
 * Build an ActionableError for the malformed-config path (item 2).
 */
export function configParseError(configPath: string, cause: unknown): ActionableError {
  return new ActionableError({
    code: "CONFIG_PARSE_ERROR",
    summary: `Could not parse wotw config at ${configPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    suggestions: [
      'Validate the file with `node -e \'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")))\' ' +
        configPath +
        "` (for JSON) or `yamllint " +
        configPath +
        "` (for YAML).",
      "Check for unmatched braces, missing colons, or trailing commas.",
      "Compare against the example at docs/configuration.md.",
      "Delete the file and re-run `wotw init` to regenerate a fresh config.",
    ],
    docs: "docs/configuration.md",
    cause,
  });
}

/**
 * Build an ActionableError for the better-sqlite3 native-binding-load
 * path (item 3).
 */
export function nativeBindingLoadError(module: string, cause: unknown): ActionableError {
  return new ActionableError({
    code: "NATIVE_BINDING_LOAD_FAILURE",
    summary: `Could not load the native binding for ${module} on this platform.`,
    suggestions: [
      "Run `pnpm rebuild " +
        module +
        "` (or `npm rebuild " +
        module +
        "`) in the install directory.",
      "Verify Node.js >= 20 is installed (`node --version`).",
      "Confirm your platform matches one of: macOS arm64, macOS amd64, Linux amd64, Windows amd64.",
      "If running under Docker, ensure the image was built for the runtime arch (not host arch).",
      "Reinstall: `npm uninstall -g @driftvane/wotw && npm install -g @driftvane/wotw`.",
    ],
    docs: "docs/install-evidence/",
    cause,
  });
}

/**
 * Build an ActionableError for the invalid-API-key path (item 4).
 */
export function invalidApiKeyError(
  provider: "anthropic" | "openai" | "gemini" | "other",
  envVar: string,
  cause?: unknown,
): ActionableError {
  return new ActionableError({
    code: "INVALID_API_KEY",
    summary: `Provider ${provider} returned 401 Unauthorized — the API key in ${envVar} is invalid or revoked.`,
    suggestions: [
      `Verify the key works: \`curl -H "x-api-key: $${envVar}" https://api.${provider === "anthropic" ? "anthropic.com" : provider + ".com"}/v1/models\` (provider URL may vary).`,
      "Regenerate the key at the provider's console if it's revoked.",
      `Re-export the new key (\`export ${envVar}="..."\`) and restart the daemon (\`wotw stop && wotw start\`).`,
      "Daemon does NOT pick up env-var changes while running — restart is required.",
    ],
    docs: "docs/self-hosted-byok.md",
    cause,
  });
}

/**
 * Detect a Claude Code CLI authentication failure in the CLI's output.
 * In CLI (subscription) runtime, a 401 surfaces in the agent's stdout as
 * an "API Error: 401 ... authentication_error ... Please run /login"
 * string rather than as an HTTP status the daemon can branch on
 * (PASS-023 dogfood finding #21).
 */
export function looksLikeCliAuthFailure(text: string): boolean {
  return (
    /API Error:\s*401/i.test(text) ||
    /authentication_error/i.test(text) ||
    /invalid authentication credentials/i.test(text) ||
    /please run \/login/i.test(text) ||
    /not (logged in|authenticated)/i.test(text)
  );
}

/**
 * Build an ActionableError for a Claude Code CLI auth failure (item 4,
 * CLI-runtime variant). Distinct remediation from the env-var API-key
 * path: the fix is `claude /login`, not rotating an env var.
 */
export function cliAuthError(cause?: unknown): ActionableError {
  return new ActionableError({
    code: "INVALID_API_KEY",
    summary:
      "The Claude Code CLI is not authenticated (got 401 from the model API). " +
      "wotw is in CLI runtime mode and the `claude` binary has no valid session.",
    suggestions: [
      "Run `claude` to open the interactive shell, then type `/login` and complete the browser auth flow.",
      'Verify auth worked: `echo "hi" | claude -p` should print a reply, not a 401.',
      "Then restart the daemon: `wotw stop && wotw start`.",
      "If you intended to use an API key instead of the subscription CLI, set `execution.mode: api` + `ANTHROPIC_API_KEY` in your config — see docs/self-hosted-byok.md.",
    ],
    docs: "docs/self-hosted-byok.md",
    cause,
  });
}

/**
 * Build an ActionableError for the rate-limited path (item 5).
 */
export function rateLimitedError(
  provider: "anthropic" | "openai" | "gemini" | "other",
  retryAfterSec?: number,
  cause?: unknown,
): ActionableError {
  return new ActionableError({
    code: "RATE_LIMITED",
    summary: `Provider ${provider} returned 429 — rate limit exceeded${
      retryAfterSec !== undefined ? ` (retry after ${retryAfterSec}s)` : ""
    }.`,
    suggestions: [
      "Lower `ingestion.concurrency` in wotw.config.yaml to spread requests further.",
      `Wait ${retryAfterSec ?? "the indicated"} seconds and retry.`,
      "Upgrade your provider tier if 429s are sustained over multiple ingest cycles.",
      "Check `wotw status` for dead-letter queue growth; clear with `wotw dlq retry` once the window recovers.",
    ],
    docs: "docs/self-hosted-byok.md",
    cause,
  });
}

/**
 * Build an ActionableError for the wiki-dir EACCES path (item 6).
 */
export function wikiDirPermissionError(path: string, cause: unknown): ActionableError {
  return new ActionableError({
    code: "WIKI_DIR_PERMISSION_DENIED",
    summary: `Cannot create or write to wiki directory at ${path}: permission denied.`,
    suggestions: [
      `Check the directory's owner and permissions: \`ls -la "${path}"\`.`,
      `Ensure the daemon's user can write: \`chmod u+w "${path}"\` (or relocate to a writable parent).`,
      "If running under Docker, confirm the volume mount has the right ownership.",
      "Choose a different `wiki_root` in wotw.config.yaml.",
    ],
    docs: "docs/configuration.md",
    cause,
  });
}

/**
 * Build an ActionableError for the locked-vault-file path (item 7).
 */
export function vaultFileLockedError(path: string, cause: unknown): ActionableError {
  return new ActionableError({
    code: "VAULT_FILE_LOCKED",
    summary: `Cannot write to ${path}: another process is holding an exclusive lock (usually Obsidian).`,
    suggestions: [
      "Close the file in Obsidian (or close Obsidian entirely) and retry the operation.",
      "On Windows, check for indexing services or backup tools that may briefly lock files.",
      "Run `wotw status` to confirm the lock cleared after closing the holder.",
      "If the lock persists with no holder visible, restart your machine.",
    ],
    docs: "docs/obsidian-setup.md",
    cause,
  });
}

/**
 * Build an ActionableError for the port-in-use path (item 8).
 */
export function portInUseError(port: number, cause?: unknown): ActionableError {
  return new ActionableError({
    code: "PORT_IN_USE",
    summary: `Port ${port} is already in use; the MCP server cannot bind.`,
    suggestions: [
      `Find the process holding the port: \`lsof -iTCP:${port} -sTCP:LISTEN\` (macOS/Linux) or \`netstat -ano | findstr :${port}\` (Windows).`,
      "Stop that process, or change `server.port` in wotw.config.yaml to a free port.",
      `If it's an orphaned wotw daemon, \`wotw stop\` (or kill the PID) and retry.`,
    ],
    docs: "docs/configuration.md",
    cause,
  });
}

/**
 * Build an ActionableError for the daemon-already-running path (item 9).
 */
export function daemonAlreadyRunningError(lockPath: string, cause?: unknown): ActionableError {
  return new ActionableError({
    code: "DAEMON_ALREADY_RUNNING",
    summary: `Another wotw daemon already holds the lock at ${lockPath}.`,
    suggestions: [
      "Run `wotw status` to see the live daemon's PID and health.",
      "If you intend to replace it, `wotw stop` first, then `wotw start`.",
      "If the lock is stale (e.g. after a crash), `wotw stop --force` clears it.",
    ],
    docs: "docs/cli-reference.md",
    cause,
  });
}

/**
 * Build an ActionableError for the non-empty-init-target path (item 10).
 */
export function initTargetNotEmptyError(
  path: string,
  conflictingEntries: readonly string[],
): ActionableError {
  return new ActionableError({
    code: "INIT_TARGET_NOT_EMPTY",
    summary: `Cannot scaffold a new vault at ${path}: target directory is not empty.`,
    suggestions: [
      `Conflicting entries: ${conflictingEntries.slice(0, 5).join(", ")}${conflictingEntries.length > 5 ? ` … (+${conflictingEntries.length - 5} more)` : ""}.`,
      "Pick a different `--path` (or an empty subdirectory of this one).",
      "If you meant to overlay onto an existing vault, this is the wrong code path — the wizard would have offered an overlay prompt. Confirm the target has `.obsidian/` and re-run.",
      "If you're sure the existing files are safe to overwrite, re-run with `--force`.",
    ],
    docs: "docs/init-walkthrough.md",
  });
}
