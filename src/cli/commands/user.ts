/**
 * `wotw user` — administer multi-user tokens.
 *
 * Subcommands:
 *   wotw user add <name>       — issue a new token (prints to stdout)
 *   wotw user list             — list active users
 *   wotw user revoke <name>    — revoke all tokens for a user
 *
 * This command operates directly on the on-disk token store under the
 * configured `multi_user.workspaces_dir`. It does NOT require the daemon
 * to be running — by design. You'll typically provision a token once,
 * bake it into a client config, and never touch it again.
 */
import type { Command } from "commander";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { TokenStore } from "../../multi-user/token-store.js";
import { chalk, fail, info, line, success, warn } from "../output.js";

export function registerUserCommand(program: Command): void {
  const user = program.command("user").description("Manage multi-user authentication tokens");

  user
    .command("add")
    .description("Issue a new token for a user (prints the token)")
    .argument("<name>", "User name")
    .action(async (name: string) => {
      await runUserAdd(name);
    });

  user
    .command("list")
    .description("List active users and token creation times")
    .option("--json", "Emit JSON")
    .action(async (opts: { json?: boolean }) => {
      await runUserList(opts);
    });

  user
    .command("revoke")
    .description("Revoke all tokens for a user")
    .argument("<name>", "User name")
    .action(async (name: string) => {
      await runUserRevoke(name);
    });
}

async function runUserAdd(name: string): Promise<void> {
  const store = await openStore();
  if (!store) return;
  try {
    const token = store.addUser(name);
    success(`Issued token for ${chalk.bold(name)}.`);
    line("");
    line(chalk.dim("Token (save this — it will not be shown again):"));
    line(`  ${chalk.yellow(token)}`);
    line("");
    info("Configure clients with `Authorization: Bearer <token>` to authenticate.");
  } catch (err) {
    fail(`Failed to add user: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

async function runUserList(opts: { json?: boolean }): Promise<void> {
  const store = await openStore();
  if (!store) return;
  const users = store.listUsers();
  if (opts.json) {
    line(JSON.stringify(users, null, 2));
    return;
  }
  if (users.length === 0) {
    info("No users configured.");
    info("Add one with `wotw user add <name>`.");
    return;
  }
  line("");
  line(chalk.bold(`Active users (${users.length}):`));
  line("");
  for (const u of users) {
    line(`  ${chalk.green("●")} ${chalk.bold(u.user.padEnd(20))} ${chalk.dim(u.created)}`);
  }
  line("");
}

async function runUserRevoke(name: string): Promise<void> {
  const store = await openStore();
  if (!store) return;
  const n = store.revokeUser(name);
  if (n === 0) {
    warn(`No tokens found for ${name}.`);
    return;
  }
  success(`Revoked ${n} token(s) for ${chalk.bold(name)}.`);
}

/**
 * Load config, check multi_user is enabled, and return a TokenStore.
 * Returns null if multi_user is disabled (with a helpful error).
 */
async function openStore(): Promise<TokenStore | null> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  if (!config.multi_user.enabled) {
    fail("Multi-user mode is not enabled in config (multi_user.enabled = false).");
    info("Set `multi_user.enabled: true` in your wotw.config.yaml to enable it.");
    process.exitCode = 1;
    return null;
  }
  const store = new TokenStore({ workspacesDir: config.multi_user.workspaces_dir });
  store.load();
  return store;
}
