/**
 * `wotw keys <subcommand>` — workspace key management CLI (G5 closure,
 * Pass 018, v0.8.2).
 *
 * Subcommands:
 * - `rotate` — rotate the workspace's active DEK. Atomically: generates
 *   a new active DEK, transitions the previous active to 'rotating'.
 *   New chain appends sign under the new DEK; verify recognizes records
 *   signed by either DEK during the overlap window.
 * - `list` — show all DEKs for the workspace with their states.
 *
 * Requires `WOTW_WORKSPACE_KEK` set in env and hosted mode with a
 * tenant_id. Out of hosted mode there's no workspace concept and the
 * daemon uses the v0.8.1 single-key fallback (no rotation needed).
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { readKekFromEnv } from "../../keys/envelope.js";
import { KeyStore } from "../../keys/store.js";
import { chalk, fail, info, line, success } from "../output.js";

interface KeysCommandOptions {
  json?: boolean;
}

export function registerKeysCommand(program: Command): void {
  const keysCmd = program
    .command("keys")
    .description("Manage workspace HMAC signing keys (G5 attestation)");

  keysCmd
    .command("rotate")
    .description("Rotate the workspace's active DEK (overlap window for verify)")
    .option("--json", "Emit a JSON summary on completion")
    .action(async (opts: KeysCommandOptions) => {
      await runRotate(opts);
    });

  keysCmd
    .command("list")
    .description("List all DEKs for the workspace with their states")
    .option("--json", "Emit JSON instead of a table")
    .action(async (opts: KeysCommandOptions) => {
      await runList(opts);
    });
}

async function loadKeyStore(): Promise<{ store: KeyStore; workspaceId: string } | null> {
  const { config: rawConfig } = await loadConfig();
  const config = resolveConfigPaths(rawConfig, process.cwd());
  if (!existsSync(config.wiki_root)) {
    fail(`wiki_root does not exist: ${config.wiki_root}`);
    process.exit(1);
  }
  if (!config.hosted.enabled || !config.hosted.tenant_id) {
    fail("workspace keys are only available in hosted mode with a tenant_id");
    info("Set hosted.enabled=true + hosted.tenant_id in wotw.config.yaml.");
    return null;
  }
  const workspaceId = config.hosted.tenant_id;
  let kek: Buffer;
  try {
    kek = readKekFromEnv();
  } catch (err) {
    fail(`failed to read WOTW_WORKSPACE_KEK: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const store = new KeyStore({ path: `${config.wiki_root}/.wotw/keys.db`, kek });
  return { store, workspaceId };
}

async function runRotate(opts: KeysCommandOptions): Promise<void> {
  const handle = await loadKeyStore();
  if (!handle) process.exit(1);
  const { store, workspaceId } = handle;
  const result = store.rotate(workspaceId);
  store.close();
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        workspace_id: workspaceId,
        previous_key_id: result.previous?.key_id ?? null,
        current_key_id: result.current.key_id,
      })}\n`,
    );
    return;
  }
  success(`Rotated workspace DEK for ${chalk.bold(workspaceId)}.`);
  if (result.previous) {
    line(`  previous: ${result.previous.key_id} → ${chalk.yellow("rotating")} (verify-only)`);
  }
  line(`  current:  ${result.current.key_id} → ${chalk.green("active")}`);
  info("Records appended from now on are signed under the new DEK.");
  info(
    "Run `wotw keys list` to inspect, or call `KeyStore.archive(previous_key_id)` after the overlap window.",
  );
}

async function runList(opts: KeysCommandOptions): Promise<void> {
  const handle = await loadKeyStore();
  if (!handle) process.exit(1);
  const { store, workspaceId } = handle;
  const rows = store.listAll(workspaceId);
  const counts = store.countByState(workspaceId);
  store.close();
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        workspace_id: workspaceId,
        counts,
        keys: rows.map((r) => ({
          key_id: r.key_id,
          key_state: r.key_state,
          created_at: r.created_at,
          rotated_at: r.rotated_at,
          revoked_at: r.revoked_at,
        })),
      })}\n`,
    );
    return;
  }
  line(chalk.bold(`Workspace keys for ${workspaceId}:`));
  line(
    `  ${chalk.green("active")}: ${counts.active}  ${chalk.yellow("rotating")}: ${counts.rotating}  ${chalk.gray("archived")}: ${counts.archived}  ${chalk.red("revoked")}: ${counts.revoked}`,
  );
  if (rows.length === 0) {
    line("  (no keys provisioned yet)");
    return;
  }
  line("");
  for (const r of rows) {
    const stateColor =
      r.key_state === "active"
        ? chalk.green
        : r.key_state === "rotating"
          ? chalk.yellow
          : r.key_state === "revoked"
            ? chalk.red
            : chalk.gray;
    line(`  ${r.key_id}  ${stateColor(r.key_state.padEnd(8))}  created=${r.created_at}`);
    if (r.rotated_at) line(`      rotated_at=${r.rotated_at}`);
    if (r.revoked_at) line(`      revoked_at=${r.revoked_at}`);
  }
}
