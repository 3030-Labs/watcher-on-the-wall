/**
 * `wotw install-hook` — add a SessionStart hook to the user's Claude Code
 * settings.json that runs the bootstrap script, which in turn ensures a
 * daemon is running before any Claude session begins.
 */
import type { Command } from "commander";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir, platform } from "node:os";
import { fail, info, success } from "../output.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

interface InstallHookOptions {
  scope?: "user" | "project";
  dryRun?: boolean;
}

/**
 * Attach the `install-hook` subcommand.
 */
export function registerInstallHookCommand(program: Command): void {
  program
    .command("install-hook")
    .description("Install a Claude Code SessionStart hook that boots the daemon")
    .option("--scope <scope>", "Where to install the hook: user | project", "user")
    .option("--dry-run", "Print what would be written without modifying files")
    .action(async (opts: InstallHookOptions) => {
      await runInstallHook(opts);
    });
}

/**
 * Implementation.
 */
export async function runInstallHook(opts: InstallHookOptions): Promise<void> {
  const settingsPath = resolveSettingsPath(opts.scope ?? "user");
  const bootstrapScript = resolveBootstrapScript();

  const hookCommand =
    platform() === "win32"
      ? `powershell -ExecutionPolicy Bypass -File "${bootstrapScript.ps1}"`
      : `bash "${bootstrapScript.sh}"`;

  interface HookEntry {
    matcher?: string;
    hooks: Array<{ type: "command"; command: string }>;
  }
  interface Settings {
    hooks?: {
      SessionStart?: HookEntry[];
    };
    [key: string]: unknown;
  }

  let existing: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      existing = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
    } catch (err) {
      fail(`Could not parse existing settings at ${settingsPath}: ${(err as Error).message}`);
      process.exitCode = 1;
      return;
    }
  }

  existing.hooks ??= {};
  existing.hooks.SessionStart ??= [];

  // Avoid duplicate install
  const already = existing.hooks.SessionStart.some((entry) =>
    entry.hooks.some((h) => h.command === hookCommand),
  );
  if (already) {
    info("SessionStart hook already installed.");
    return;
  }

  existing.hooks.SessionStart.push({
    matcher: "*",
    hooks: [{ type: "command", command: hookCommand }],
  });

  if (opts.dryRun) {
    info(`Would write to ${settingsPath}:`);
    info(JSON.stringify(existing, null, 2));
    return;
  }

  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2));
  success(`Installed SessionStart hook at ${settingsPath}`);
  info(`Hook command: ${hookCommand}`);
}

/** Resolve the Claude Code settings.json path for the chosen scope. */
function resolveSettingsPath(scope: "user" | "project"): string {
  if (scope === "project") {
    return join(process.cwd(), ".claude", "settings.json");
  }
  return join(homedir(), ".claude", "settings.json");
}

/** Locate the bootstrap scripts bundled in templates/. */
function resolveBootstrapScript(): { sh: string; ps1: string } {
  const here = fileURLToPath(import.meta.url);
  const candidates = [
    resolve(here, "..", "..", "..", "templates"),
    resolve(here, "..", "..", "..", "..", "templates"),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, "ensure-running.sh"))) {
      return {
        sh: join(c, "ensure-running.sh"),
        ps1: join(c, "ensure-running.ps1"),
      };
    }
  }
  // Fall back to the first candidate even if files don't exist yet — templates
  // are written in Phase 5 but the install-hook command still resolves paths.
  const base = candidates[0] as string;
  return {
    sh: join(base, "ensure-running.sh"),
    ps1: join(base, "ensure-running.ps1"),
  };
}
