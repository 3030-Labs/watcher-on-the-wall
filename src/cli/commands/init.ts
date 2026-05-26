/**
 * `wotw init` — interactive setup wizard.
 *
 * Unlike the original single-shot scaffolder, this command is Obsidian-aware:
 * it detects existing Obsidian vaults from the platform-specific registry,
 * lets the user overlay `raw/` + `wiki/` inside an existing vault (or create
 * a fresh one), sanity-checks the runtime (Claude CLI vs API key), and
 * offers to launch the result in Obsidian on completion.
 *
 * It is also idempotent: re-running `wotw init` on an already-initialized
 * directory verifies the structure and exits 0 without touching anything.
 *
 * Non-interactive mode (no TTY, CI, `--yes`) skips every prompt, uses the
 * current working directory (or `--path`) as the vault, accepts all
 * defaults, and does not open Obsidian.
 *
 * Layout after scaffolding (vault root = vault/):
 *
 *   vault/
 *     .gitignore
 *     wotw.yaml              <- config, paths relative to vault root
 *     CLAUDE.md              <- LLM schema
 *     wiki/
 *       index.md             <- starter page with sentinel block
 *       log.md
 *       concepts/
 *       entities/
 *       sources/
 *       comparisons/
 *       syntheses/
 *       queries/
 *     raw/                   <- user drops source files here
 *     .obsidian/             <- only created for fresh vaults
 *       app.json
 *       appearance.json
 *       graph.json
 *
 * Flags:
 *   wotw init [dir]          <- positional path, overrides auto-detect
 *   -p, --path <dir>         <- same, long-form alternative
 *   -y, --yes                <- skip prompts, accept defaults
 *   --no-open                <- skip the "open in Obsidian" step
 *   -f, --force              <- overwrite existing scaffold (legacy escape hatch)
 */
import * as p from "@clack/prompts";
import type { Command } from "commander";
import { getTelemetrySink, recordInitFailure } from "../../telemetry/index.js";
import { initTargetNotEmptyError, isActionableError } from "../../utils/actionable-error.js";
import { errMsg } from "../../utils/errors.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findApiKey, findOnPath } from "../../ingestion/execution-mode.js";
import { defaultConfig } from "../../daemon/config.js";
import { ensureDirSync, expandHome } from "../../utils/fs.js";
import { ensureGitRepo } from "../../utils/git.js";
import { fail, info, line, success, warn } from "../output.js";
import {
  findEnclosingVault,
  findObsidianVaults,
  openInObsidian,
  type ObsidianVault,
} from "../lib/vault-detect.js";

/** Ordered list of category subdirectories created under `wiki/`. */
const WIKI_CATEGORY_DIRS = [
  "concepts",
  "entities",
  "sources",
  "comparisons",
  "syntheses",
  "queries",
] as const;

interface InitOptions {
  /** Legacy CLI flag / programmatic override for the vault path. */
  path?: string;
  /** Suppress prompts and accept defaults (also auto-set when stdin is not a TTY). */
  yes?: boolean;
  /**
   * When `false`, skip the "open in Obsidian" step. Commander maps `--no-open`
   * to `open: false`.
   */
  open?: boolean;
  /** Overwrite an existing scaffold. Bypasses the idempotency short-circuit. */
  force?: boolean;
  /**
   * Internal override used by tests: treat stdin as non-TTY even when it
   * actually is, to take the deterministic code path.
   */
  nonInteractive?: boolean;
}

/** Result of the idempotency check at the start of the wizard. */
interface AlreadyInitializedResult {
  initialized: boolean;
  reason?: string;
}

/** What `runInit` returns to the caller (CLI action or tests). */
export interface RunInitResult {
  /** Absolute vault path that was initialized (or found already-initialized). */
  root: string;
  /** Set when the idempotency check short-circuited the wizard. */
  alreadyInitialized: boolean;
  /** True when a fresh vault was scaffolded (no pre-existing `.obsidian/`). */
  createdFreshVault: boolean;
  /**
   * When the user overlaid into a subdirectory rather than the vault root,
   * this is the absolute path to that subdirectory. Otherwise null.
   */
  overlaySubdir: string | null;
}

/** Runtime detection summary for Step 4. */
interface RuntimeDetection {
  mode: "cli" | "api" | "none";
  cliPath: string | null;
  apiKeyEnv: string | null;
}

/** Decoded selection from the vault-location prompt. */
type Choice = { kind: "vault"; vault: ObsidianVault } | { kind: "cwd" } | { kind: "custom" };

/**
 * Attach the `init` subcommand to a Commander program.
 */
export function registerInitCommand(program: Command): void {
  program
    .command("init [dir]")
    .description("Scaffold a new wiki vault (Obsidian-aware interactive wizard)")
    .option("-p, --path <dir>", "Vault path (skip detection)")
    .option("-y, --yes", "Accept all defaults, no prompts")
    .option("--no-open", "Skip opening Obsidian on completion")
    .option("-f, --force", "Overwrite existing files if already initialized")
    .action(async (dir: string | undefined, opts: InitOptions) => {
      try {
        const pathArg = dir ?? opts.path;
        await runInit({ ...opts, path: pathArg });
      } catch (err) {
        if (errMsg(err) === "cancelled") {
          // User hit Ctrl-C during a prompt — exit quietly.
          process.exitCode = 0;
          return;
        }
        // Opt-in BYO-DSN telemetry: best-effort categorical record of
        // the failure, gated on WOTW_TELEMETRY_DSN being set. Default
        // is no-op. See docs/telemetry.md.
        recordInitFailure(getTelemetrySink(), err);
        // Re-throw ActionableErrors so the CLI top-level handler
        // renders them with structured suggestions. Plain errors
        // continue to use the legacy "init failed: ..." path.
        if (isActionableError(err)) {
          throw err;
        }
        fail(`init failed: ${errMsg(err)}`);
        process.exitCode = 1;
      }
    });
}

/**
 * Implementation used by the CLI action and by integration tests.
 *
 * Returns a {@link RunInitResult}. Throws on fatal scaffolding errors; swallows
 * user-cancels from the prompt library via the "cancelled" sentinel error.
 */
export async function runInit(opts: InitOptions): Promise<RunInitResult> {
  const interactive = isInteractive(opts);
  const ttyPath = resolveExplicitVaultPath(opts.path);

  if (interactive) {
    p.intro("watcher-on-the-wall — setup wizard");
  }

  // --- Step 2: vault location ---------------------------------------------
  let vaultPath: string;
  const envVaultPath = resolveEnvVaultPath();
  if (ttyPath !== null) {
    vaultPath = ttyPath;
  } else if (envVaultPath !== null) {
    vaultPath = envVaultPath;
  } else if (interactive) {
    vaultPath = await promptForVaultPath();
  } else {
    vaultPath = process.cwd();
  }

  // --- Step 1.5: idempotency check (on the resolved vault path) ----------
  const already = checkAlreadyInitialized(vaultPath);
  if (already.initialized && !opts.force) {
    const msg = `Already initialized at ${vaultPath} — structure verified, nothing to do.`;
    if (interactive) {
      p.note(msg, "Idempotent re-run");
      p.outro("Nothing to do.");
    } else {
      info(msg);
    }
    return {
      root: vaultPath,
      alreadyInitialized: true,
      createdFreshVault: false,
      overlaySubdir: null,
    };
  }

  // --- Step 2.5: non-empty-target guard ------------------------------------
  // If the target exists, has content, AND is neither an Obsidian vault nor a
  // partial wotw scaffold, refuse to scaffold over it. This catches the
  // "stranger ran `wotw init` in their Downloads folder" mistake before the
  // wizard scatters files into a user-meaningful directory.
  if (!opts.force) {
    const collision = detectNonEmptyTargetCollision(vaultPath);
    if (collision !== null) {
      throw initTargetNotEmptyError(vaultPath, collision);
    }
  }

  // --- Step 3: overlay detection -----------------------------------------
  const hasObsidianDir = existsSync(join(vaultPath, ".obsidian"));
  let overlayDir: string = vaultPath;
  let overlaySubdir: string | null = null;

  if (hasObsidianDir && interactive) {
    const overlay = await ask(
      p.confirm({
        message: "Found an existing Obsidian vault. Create raw/ and wiki/ inside it?",
        initialValue: true,
      }),
    );
    if (!overlay) {
      const sub = await ask(
        p.text({
          message: "Subdirectory name (will be created inside the vault)",
          placeholder: "wotw",
          initialValue: "wotw",
          validate(value) {
            if (!value || value.trim().length === 0) return "Subdirectory name is required";
            if (value.includes("/") || value.includes("\\")) {
              return "Must be a single directory name, not a path";
            }
            return undefined;
          },
        }),
      );
      overlayDir = join(vaultPath, sub.trim());
      overlaySubdir = overlayDir;
    }
  } else if (!hasObsidianDir && interactive) {
    p.note(
      `No existing .obsidian/ detected — ${vaultPath} will be set up as a fresh vault with sensible Obsidian defaults.`,
      "Fresh vault",
    );
  }

  // --- Step 4: runtime detection -----------------------------------------
  const runtime = detectRuntime();
  if (interactive) {
    p.note(runtimeSummary(runtime), "Runtime");
  } else if (runtime.mode === "none") {
    warn(
      "No runtime detected. Install `claude` CLI (https://docs.claude.com/claude-code) or set ANTHROPIC_API_KEY.",
    );
  }

  // --- Step 5: scaffold --------------------------------------------------
  const isFreshVault = !hasObsidianDir;
  const spin = interactive ? p.spinner() : null;
  spin?.start("Scaffolding wiki structure");
  try {
    await scaffoldVault(overlayDir, vaultPath, { isFreshVault, force: opts.force === true });
    spin?.stop("Wiki scaffolded");
  } catch (err) {
    spin?.stop("Scaffold failed");
    throw err;
  }

  // --- Step 6: open in Obsidian ------------------------------------------
  if (interactive && opts.open !== false) {
    const shouldOpen = await ask(
      p.confirm({
        message: "Open vault in Obsidian now?",
        initialValue: true,
      }),
    );
    if (shouldOpen) {
      const ok = await openInObsidian(vaultPath);
      if (!ok) {
        const anyVaults = findObsidianVaults().length > 0;
        if (anyVaults) {
          p.note(
            "Couldn't open Obsidian automatically. Open the folder as a vault manually.",
            "Launch skipped",
          );
        } else {
          p.note(
            "Obsidian doesn't appear to be installed. Your wiki is plain markdown and\n" +
              "works without it, but for the best experience install Obsidian from\n" +
              "https://obsidian.md and open this folder as a vault.",
            "Obsidian not installed",
          );
        }
      }
    }
  }

  // --- Step 7: success + next steps --------------------------------------
  const nextSteps = renderNextSteps();
  if (interactive) {
    p.note(nextSteps, "Next steps");
    p.outro("Done! Your wiki is ready.");
  } else {
    success(`Wiki initialized at ${vaultPath}`);
    line("");
    line(nextSteps);
  }

  return {
    root: vaultPath,
    alreadyInitialized: false,
    createdFreshVault: isFreshVault,
    overlaySubdir,
  };
}

// ---------------------------------------------------------------------------
// Step helpers
// ---------------------------------------------------------------------------

/**
 * True when the user should see interactive prompts. Stdin must be a TTY
 * AND `--yes` / non-interactive override must not be set.
 */
function isInteractive(opts: InitOptions): boolean {
  if (opts.nonInteractive === true) return false;
  if (opts.yes === true) return false;
  return process.stdin.isTTY === true;
}

/** Resolve an explicit `--path` / positional argument to an absolute path, or null. */
function resolveExplicitVaultPath(input: string | undefined): string | null {
  if (!input) return null;
  const expanded = expandHome(input);
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Resolve the OBSIDIAN_VAULT_PATH environment variable to an absolute path,
 * or null when unset/empty. This takes precedence over the cwd fallback in
 * non-interactive mode and over the prompt in interactive mode — operators
 * who export it expect it to be honored.
 */
function resolveEnvVaultPath(): string | null {
  const raw = process.env.OBSIDIAN_VAULT_PATH;
  if (!raw || raw.trim().length === 0) return null;
  const expanded = expandHome(raw.trim());
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/**
 * Detect whether `vaultPath` is a non-empty directory that is NEITHER an
 * Obsidian vault NOR an existing wotw scaffold. Returns the list of
 * conflicting top-level entries when collision detected, or null when the
 * target is safe to scaffold into.
 *
 * Considered safe:
 *   - path doesn't exist (will be created during scaffold)
 *   - path is an empty directory
 *   - path contains `.obsidian/` (overlay path; prompt will handle subdir choice)
 *   - path is already a wotw scaffold (caught upstream by checkAlreadyInitialized)
 */
function detectNonEmptyTargetCollision(vaultPath: string): string[] | null {
  if (!existsSync(vaultPath)) return null;
  let entries: string[];
  try {
    entries = readdirSync(vaultPath);
  } catch {
    // Unreadable — let downstream EACCES handling surface that distinctly.
    return null;
  }
  // Hidden-file noise + macOS/Windows housekeeping entries don't count.
  const ignored = new Set([".DS_Store", "Thumbs.db", ".git", ".gitignore"]);
  const meaningful = entries.filter((e) => !ignored.has(e));
  if (meaningful.length === 0) return null;
  // Obsidian vault → overlay flow handles this.
  if (meaningful.includes(".obsidian")) return null;
  // Existing wotw scaffold → idempotency guard handles this.
  if (
    meaningful.includes(".wotw") ||
    meaningful.includes("wotw.config.yaml") ||
    (meaningful.includes("raw") && meaningful.includes("wiki"))
  ) {
    return null;
  }
  return meaningful;
}

/**
 * Interactive vault-location prompt. Lists detected Obsidian vaults plus
 * "current directory" and "enter a custom path" options, then returns the
 * chosen absolute path. Falls back to a free-form text prompt when no
 * vaults are discovered.
 */
async function promptForVaultPath(): Promise<string> {
  const vaults = findObsidianVaults();
  const cwd = process.cwd();
  const enclosing = findEnclosingVault(cwd);

  // Move the enclosing vault to the front of the list if present.
  if (enclosing !== null) {
    const idx = vaults.findIndex((v) => resolve(v.path) === resolve(enclosing));
    if (idx > 0) {
      const [found] = vaults.splice(idx, 1);
      if (found) vaults.unshift(found);
    } else if (idx === -1) {
      vaults.unshift({
        name: basename(enclosing),
        path: enclosing,
        ts: Date.now(),
        open: false,
      });
    }
  }

  // Encode the choice as a string id (`vault:<idx>`, `cwd`, `custom`) so we
  // sidestep clack's distributive typing over object values. We decode it
  // back into `Choice` after the prompt returns.
  const options: Array<{ value: string; label: string; hint?: string }> = [];
  vaults.forEach((v, idx) => {
    options.push({
      value: `vault:${idx}`,
      label: v.name,
      hint: v.path,
    });
  });
  options.push({
    value: "cwd",
    label: "Create new vault here",
    hint: cwd,
  });
  options.push({
    value: "custom",
    label: "Enter a custom path",
  });

  if (vaults.length === 0) {
    // No registry hits — go straight to a text prompt, defaulting to cwd.
    const custom = await ask(
      p.text({
        message: "Vault path",
        placeholder: cwd,
        initialValue: cwd,
        validate: validateVaultPath,
      }),
    );
    return resolvePromptPath(custom);
  }

  const choiceId = await ask(
    p.select<string>({
      message: "Where should the wiki live?",
      options,
    }),
  );

  const choice = decodeChoice(choiceId, vaults);
  if (choice.kind === "vault") return resolve(choice.vault.path);
  if (choice.kind === "cwd") return cwd;

  const custom = await ask(
    p.text({
      message: "Vault path",
      placeholder: cwd,
      initialValue: cwd,
      validate: validateVaultPath,
    }),
  );
  return resolvePromptPath(custom);
}

/**
 * Decode the string id produced by the vault `p.select` prompt back into a
 * typed `Choice` discriminated union. Unknown ids fall back to `"custom"` so
 * the caller's text-prompt branch fires.
 */
function decodeChoice(id: string, vaults: ObsidianVault[]): Choice {
  if (id === "cwd") return { kind: "cwd" };
  if (id.startsWith("vault:")) {
    const idx = Number.parseInt(id.slice("vault:".length), 10);
    const v = Number.isInteger(idx) ? vaults[idx] : undefined;
    if (v) return { kind: "vault", vault: v };
  }
  return { kind: "custom" };
}

/** Validate a text-prompt path. Returns an error message or undefined. */
function validateVaultPath(value: string | undefined): string | undefined {
  if (!value || value.trim().length === 0) return "Path is required";
  return undefined;
}

/** Expand `~`, make absolute relative to cwd. */
function resolvePromptPath(raw: string): string {
  const expanded = expandHome(raw.trim());
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

/** Wrap a clack prompt with cancel-to-exception plumbing. */
async function ask<T>(prompt: Promise<T | symbol>): Promise<T> {
  const result = await prompt;
  if (p.isCancel(result)) {
    p.cancel("Cancelled.");
    throw new Error("cancelled");
  }
  return result as T;
}

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

/**
 * Quick structural check: does the target directory look like a fully
 * initialized wotw vault? We look for a config file at the vault root plus
 * the wiki/ and raw/ subdirectories with the expected category layout.
 */
function checkAlreadyInitialized(vaultPath: string): AlreadyInitializedResult {
  if (!existsSync(vaultPath)) return { initialized: false };
  try {
    if (!statSync(vaultPath).isDirectory()) {
      return { initialized: false, reason: "target is not a directory" };
    }
  } catch {
    return { initialized: false };
  }

  const hasConfig = CONFIG_CANDIDATES.some((name) => existsSync(join(vaultPath, name)));
  if (!hasConfig) return { initialized: false };

  const rawDir = join(vaultPath, "raw");
  const wikiDir = join(vaultPath, "wiki");
  if (!existsSync(rawDir) || !existsSync(wikiDir)) return { initialized: false };

  // Category subdirectories must all be present — otherwise the user has a
  // half-built vault and we should treat it as uninitialized.
  for (const cat of WIKI_CATEGORY_DIRS) {
    if (!existsSync(join(wikiDir, cat))) {
      return { initialized: false, reason: `missing wiki/${cat}` };
    }
  }
  return { initialized: true };
}

/**
 * Config filenames we recognize when checking for an existing scaffold.
 * Lines up with cosmiconfig's searchPlaces in `src/daemon/config.ts`.
 */
const CONFIG_CANDIDATES = [
  "wotw.yaml",
  "wotw.yml",
  "wotw.config.yaml",
  "wotw.config.yml",
  "wotw.config.json",
  ".wotwrc",
  ".wotwrc.json",
  ".wotwrc.yaml",
  ".wotwrc.yml",
] as const;

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

/** Silent sibling of `resolveExecutionMode` — detect without throwing. */
function detectRuntime(): RuntimeDetection {
  const defaults = defaultConfig();
  const cliPath = findOnPath(defaults.execution.cli_path);
  if (cliPath !== null) {
    return { mode: "cli", cliPath, apiKeyEnv: null };
  }
  const keyEnv = findApiKey(defaults.execution.api_key_env);
  if (keyEnv !== null) {
    return { mode: "api", cliPath: null, apiKeyEnv: keyEnv };
  }
  return { mode: "none", cliPath: null, apiKeyEnv: null };
}

/** Human-readable one-paragraph summary of the detected runtime. */
function runtimeSummary(runtime: RuntimeDetection): string {
  if (runtime.mode === "cli") {
    return `CLI mode (claude binary found at ${runtime.cliPath ?? "<unknown>"})`;
  }
  if (runtime.mode === "api") {
    return `API mode (${runtime.apiKeyEnv} detected)`;
  }
  return (
    "No runtime detected. You'll need either:\n" +
    "  • claude CLI binary on your PATH (free with Claude Pro/Max)\n" +
    "  • ANTHROPIC_API_KEY environment variable (pay-per-token)"
  );
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

interface ScaffoldOptions {
  isFreshVault: boolean;
  force: boolean;
}

/**
 * Create every directory and file the daemon needs inside `overlayDir`. The
 * Obsidian `.obsidian/` directory and the top-level `.gitignore` are written
 * at `vaultRoot`, which is the same as `overlayDir` except when the user
 * opted into a subdirectory overlay.
 */
async function scaffoldVault(
  overlayDir: string,
  vaultRoot: string,
  opts: ScaffoldOptions,
): Promise<void> {
  // Directories
  ensureDirSync(overlayDir);
  ensureDirSync(join(overlayDir, "raw"));
  const wikiDir = join(overlayDir, "wiki");
  ensureDirSync(wikiDir);
  for (const cat of WIKI_CATEGORY_DIRS) {
    ensureDirSync(join(wikiDir, cat));
  }
  // Candidates staging directory (for approve/reject workflow).
  ensureDirSync(join(overlayDir, "candidates"));
  ensureDirSync(join(overlayDir, "candidates", "rejected"));

  // Templates (index.md, log.md, CLAUDE.md) live next to the compiled JS
  // at runtime; fall back to the source tree for `pnpm test`.
  const templatesDir = resolveTemplatesDir();
  const indexTemplate = readFileSync(join(templatesDir, "index.md"), "utf8");
  const logTemplate = readFileSync(join(templatesDir, "log.md"), "utf8");
  const claudeTemplate = readFileSync(join(templatesDir, "CLAUDE.md"), "utf8");
  const gettingStartedTemplate = readFileSync(join(templatesDir, "getting-started.md"), "utf8");

  const isoNow = new Date().toISOString();
  const indexWithTs = indexTemplate.replace("__WOTW_UPDATED_ISO__", isoNow);
  const gettingStartedWithTs = gettingStartedTemplate.replace(/__WOTW_UPDATED_ISO__/g, isoNow);

  writeIfMissingOrForce(join(wikiDir, "index.md"), indexWithTs, opts.force);
  writeIfMissingOrForce(join(wikiDir, "log.md"), logTemplate, opts.force);
  writeIfMissingOrForce(join(wikiDir, "getting-started.md"), gettingStartedWithTs, opts.force);
  writeIfMissingOrForce(join(overlayDir, "CLAUDE.md"), claudeTemplate, opts.force);

  // wotw.yaml at vault root (NOT overlayDir — the config discovery walks up
  // from cwd, so the config file lives at the user-facing vault root).
  const configPath = join(vaultRoot, "wotw.yaml");
  const configYaml = renderDefaultConfigYaml(overlayDir, vaultRoot);
  writeIfMissingOrForce(configPath, configYaml, opts.force);

  // .gitignore at vault root — append-or-create.
  writeGitignore(join(vaultRoot, ".gitignore"));

  // Obsidian metadata — only for fresh vaults.
  if (opts.isFreshVault) {
    writeObsidianDefaults(vaultRoot);
  }

  // Initialize a git repo at the vault root so every ingestion becomes a
  // commit. Silent no-op if a repo already exists.
  await ensureGitRepo(vaultRoot, "chore: wotw init — scaffold wiki store");
}

/**
 * Write a file if it does not already exist. Honors `--force` by
 * overwriting when set. The intent is to preserve user content during
 * overlay operations.
 */
function writeIfMissingOrForce(path: string, contents: string, force: boolean): void {
  if (!existsSync(path) || force) {
    writeFileSync(path, contents);
  }
}

/**
 * Render the wotw.yaml emitted by `wotw init`. Paths are stored relative to
 * the vault root so the vault is portable between machines — users just run
 * `wotw start` from inside the vault and cosmiconfig + resolveConfigPaths
 * walk from there.
 *
 * If the wiki is being overlaid into a subdirectory of the vault root, the
 * subdirectory name is baked into the relative paths.
 */
function renderDefaultConfigYaml(overlayDir: string, vaultRoot: string): string {
  const rel = relativeForYaml(overlayDir, vaultRoot);
  const wikiRoot = rel === "." ? "." : `./${rel}`;
  const rawPath = rel === "." ? "./raw" : `./${rel}/raw`;
  return `# watcher-on-the-wall configuration
# Generated by 'wotw init'. Edit freely; see docs/configuration.md.
#
# wiki_root is the directory that contains the wiki/ subfolder of generated
# pages (index.md, concepts/, entities/, …). raw_path is where you drop
# source files — a sibling of wiki/ at the vault root.

wiki_root: ${wikiRoot}
raw_path: ${rawPath}

execution:
  mode: auto
  cli_model: claude-sonnet-4-5

server:
  port: 8787
  host: 127.0.0.1
`;
}

/**
 * POSIX-style relative path from `from` to `to`, used when rendering the
 * `wotw.yaml`. When they're equal, returns ".".
 */
function relativeForYaml(to: string, from: string): string {
  const a = resolve(from);
  const b = resolve(to);
  if (a === b) return ".";
  // Compute a platform-agnostic relative form by string prefix comparison.
  // The init command only ever produces subdir overlays of a vault root, so
  // a simple prefix strip is sufficient (and avoids `..` noise).
  const prefix = a.endsWith("/") || a.endsWith("\\") ? a : `${a}/`;
  if (b.startsWith(prefix)) {
    return b.slice(prefix.length).replace(/\\/g, "/");
  }
  // Fallback: just use the last segment.
  return basename(b);
}

/**
 * Write a new `.gitignore` if one doesn't exist, otherwise append the wotw
 * rules to the existing file if they aren't already present.
 */
function writeGitignore(gitignorePath: string): void {
  const wotwBlock = [
    "",
    "# wotw daemon state",
    ".wotw/",
    "*.pid",
    "*.lock",
    "",
    "# OS",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "",
  ].join("\n");

  const fullGitignore = [
    "# Obsidian — device-specific (do not sync)",
    ".obsidian/workspace.json",
    ".obsidian/workspace-mobile.json",
    ".obsidian/cache/",
    ".obsidian/plugins/*/data.json",
    "",
    "# wotw daemon state",
    ".wotw/",
    "*.pid",
    "*.lock",
    "",
    "# OS",
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
    "",
  ].join("\n");

  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, fullGitignore);
    return;
  }

  const existing = readFileSync(gitignorePath, "utf8");
  if (existing.includes("# wotw") || existing.includes(".wotw/")) {
    return;
  }
  const separator = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(gitignorePath, `${existing}${separator}${wotwBlock}`);
}

/**
 * Create `.obsidian/` with minimal sane defaults. Only called for fresh
 * vaults — we never touch an existing `.obsidian/` directory because
 * Obsidian owns it after first launch.
 */
function writeObsidianDefaults(vaultRoot: string): void {
  const obsDir = join(vaultRoot, ".obsidian");
  if (existsSync(obsDir)) return;
  mkdirSync(obsDir, { recursive: true });

  const appJson = {
    attachmentFolderPath: "raw/assets",
    newFileLocation: "folder",
    newFileFolderPath: "raw",
    alwaysUpdateLinks: true,
    showUnsupportedFiles: false,
  };
  const appearanceJson = { accentColor: "#7c3aed" };
  const graphJson = {
    "collapse-filter": false,
    search: "",
    showTags: true,
    showAttachments: false,
    showOrphans: true,
    "collapse-color-groups": false,
    colorGroups: [
      { query: "path:wiki/sources", color: { a: 1, rgb: 5145874 } },
      { query: "path:wiki/syntheses", color: { a: 1, rgb: 10371072 } },
      { query: "path:raw", color: { a: 1, rgb: 8421504 } },
    ],
    "collapse-display": false,
    showArrow: true,
    textFadeMultiplier: 0,
    nodeSizeMultiplier: 1,
    lineSizeMultiplier: 1,
  };

  writeFileSync(join(obsDir, "app.json"), `${JSON.stringify(appJson, null, 2)}\n`);
  writeFileSync(join(obsDir, "appearance.json"), `${JSON.stringify(appearanceJson, null, 2)}\n`);
  writeFileSync(join(obsDir, "graph.json"), `${JSON.stringify(graphJson, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Template resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the templates directory. When bundled by tsup, templates are copied
 * next to the compiled JS. In development we fall back to the source directory.
 */
function resolveTemplatesDir(): string {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(here, "..", "..", "..", "wiki", "templates"),
    resolve(here, "..", "..", "wiki", "templates"),
    resolve(here, "..", "..", "..", "..", "src", "wiki", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "CLAUDE.md"))) return c;
  }
  throw new Error(`Could not locate wiki templates directory. Checked: ${candidates.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

/** The "what should I do next?" panel printed on successful init. */
function renderNextSteps(): string {
  return [
    "1. Drop source files into raw/",
    "2. wotw start                    # Launch the Watcher",
    "3. wotw status                   # Check it's running",
    '4. wotw query "your question"    # Ask your wiki anything',
    "",
    "(Advanced) wotw install-hook     # Auto-start with Claude Code sessions",
    "",
    "The Watcher is ready. It will handle the rest.",
  ].join("\n");
}
