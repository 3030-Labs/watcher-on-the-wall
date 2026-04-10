/**
 * `wotw uninstall-hook` — remove the SessionStart hook installed by
 * `wotw install-hook`.
 */
import type { Command } from "commander";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { info, success } from "../output.js";

interface UninstallHookOptions {
  scope?: "user" | "project";
}

/**
 * Attach the `uninstall-hook` subcommand.
 */
export function registerUninstallHookCommand(program: Command): void {
  program
    .command("uninstall-hook")
    .description("Remove the Claude Code SessionStart hook installed by wotw")
    .option("--scope <scope>", "Where the hook was installed: user | project", "user")
    .action(async (opts: UninstallHookOptions) => {
      await runUninstallHook(opts);
    });
}

export async function runUninstallHook(opts: UninstallHookOptions): Promise<void> {
  const scope = opts.scope ?? "user";
  const settingsPath =
    scope === "project"
      ? join(process.cwd(), ".claude", "settings.json")
      : join(homedir(), ".claude", "settings.json");

  if (!existsSync(settingsPath)) {
    info("No settings.json found. Nothing to remove.");
    return;
  }

  interface HookEntry {
    matcher?: string;
    hooks: Array<{ type: string; command: string }>;
  }
  interface Settings {
    hooks?: { SessionStart?: HookEntry[] };
    [key: string]: unknown;
  }

  const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as Settings;
  if (!parsed.hooks?.SessionStart || parsed.hooks.SessionStart.length === 0) {
    info("No SessionStart hooks to remove.");
    return;
  }

  const before = parsed.hooks.SessionStart.length;
  parsed.hooks.SessionStart = parsed.hooks.SessionStart.filter((entry) => {
    const filtered = entry.hooks.filter((h) => !isWotwHook(h.command));
    entry.hooks = filtered;
    return entry.hooks.length > 0;
  });
  const after = parsed.hooks.SessionStart.length;

  writeFileSync(settingsPath, JSON.stringify(parsed, null, 2));
  success(`Removed ${before - after} wotw SessionStart hook entries from ${settingsPath}`);
}

function isWotwHook(command: string): boolean {
  return command.includes("ensure-running.sh") || command.includes("ensure-running.ps1");
}
