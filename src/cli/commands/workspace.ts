/**
 * `wotw workspace <subcommand>` — workspace-level operations (G5
 * substrate, PASS-019 Parts B+C).
 *
 * Subcommands:
 * - `rotate-kek --confirm` — re-encrypt every non-revoked DEK under
 *   a new KEK (PASS-019 Part B). Reads the new KEK from env var
 *   `WOTW_WORKSPACE_KEK_NEW` (same encoding as WOTW_WORKSPACE_KEK:
 *   base64 or hex of 32 bytes). Refuses without --confirm because
 *   KEK rotation is operator-driven and irreversible without a
 *   matching rollback step. Runbook: `docs/policies/kek-rotation.md`.
 * - `archive-overlapped [--overlap-hours N]` — manual trigger for the
 *   auto-archive sweep (PASS-019 Part C). Useful for operators who
 *   want to force-archive rotating DEKs immediately after a
 *   successful production rollout without waiting for the hourly
 *   cron. Default overlap is `WOTW_DEK_OVERLAP_HOURS` env (default 24).
 *
 * Requires hosted mode + tenant_id (workspace concept). Out of hosted
 * mode the daemon uses the v0.8.1 single-key fallback and these
 * commands have nothing to act on.
 */
import type { Command } from "commander";
import { existsSync } from "node:fs";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { parseKek, readKekFromEnv } from "../../keys/envelope.js";
import { KeyStore } from "../../keys/store.js";
import { chalk, fail, info, line, success } from "../output.js";

interface RotateKekOptions {
  confirm?: boolean;
  json?: boolean;
}

interface ArchiveOverlappedOptions {
  overlapHours?: string;
  json?: boolean;
}

export function registerWorkspaceCommand(program: Command): void {
  const wsCmd = program
    .command("workspace")
    .description("Workspace-level operations (G5 attestation substrate)");

  wsCmd
    .command("rotate-kek")
    .description(
      "Re-encrypt every non-revoked DEK under a new KEK (set WOTW_WORKSPACE_KEK_NEW first)",
    )
    .option("--confirm", "Required: explicit confirmation, KEK rotation is operator-driven")
    .option("--json", "Emit a JSON summary on completion")
    .action(async (opts: RotateKekOptions) => {
      await runRotateKek(opts);
    });

  wsCmd
    .command("archive-overlapped")
    .description("Archive every 'rotating' DEK past the overlap window (manual cron trigger)")
    .option(
      "--overlap-hours <n>",
      "Override the overlap window in hours (default WOTW_DEK_OVERLAP_HOURS or 24)",
    )
    .option("--json", "Emit JSON")
    .action(async (opts: ArchiveOverlappedOptions) => {
      await runArchiveOverlapped(opts);
    });
}

interface WorkspaceHandle {
  store: KeyStore;
  workspaceId: string;
}

async function loadWorkspace(): Promise<WorkspaceHandle | null> {
  const { config: rawConfig } = await loadConfig();
  const config = resolveConfigPaths(rawConfig, process.cwd());
  if (!existsSync(config.wiki_root)) {
    fail(`wiki_root does not exist: ${config.wiki_root}`);
    process.exit(1);
  }
  if (!config.hosted.enabled || !config.hosted.tenant_id) {
    fail("workspace ops require hosted mode with a tenant_id");
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

async function runRotateKek(opts: RotateKekOptions): Promise<void> {
  if (!opts.confirm) {
    fail("KEK rotation requires --confirm");
    info("See docs/policies/kek-rotation.md for the operator runbook.");
    process.exit(1);
  }
  const newKekRaw = process.env.WOTW_WORKSPACE_KEK_NEW;
  if (!newKekRaw) {
    fail("WOTW_WORKSPACE_KEK_NEW is not set in environment");
    info(
      "Generate a fresh 32-byte KEK out-of-band (e.g. `openssl rand -base64 32`), set it via Fly secrets as WOTW_WORKSPACE_KEK_NEW alongside the existing WOTW_WORKSPACE_KEK, restart the daemon, then re-run this command.",
    );
    process.exit(1);
  }
  let newKek: Buffer;
  try {
    newKek = parseKek(newKekRaw);
  } catch (err) {
    fail(
      `failed to parse WOTW_WORKSPACE_KEK_NEW: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  const handle = await loadWorkspace();
  if (!handle) process.exit(1);
  const { store, workspaceId } = handle;
  const result = store.rotateKek(newKek);
  store.close();
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        workspace_id: workspaceId,
        rotated: result.rotated,
      })}\n`,
    );
    return;
  }
  success(
    `Rotated KEK for ${chalk.bold(workspaceId)} — ${result.rotated} DEK row(s) re-encrypted.`,
  );
  info("Next steps (operator):");
  line(
    "  1. Verify daemon still serves /healthz and chain verifies (run `wotw status` + the cloud-side verify probe).",
  );
  line(
    "  2. Swap the Fly secret: set WOTW_WORKSPACE_KEK to the new KEK, unset WOTW_WORKSPACE_KEK_NEW.",
  );
  line("  3. Restart the daemon — it should re-open keys.db cleanly under the new KEK.");
  info(
    "If anything misbehaves, roll back by setting WOTW_WORKSPACE_KEK back to the old value (daemon must still be running under both for that to work — see runbook).",
  );
}

async function runArchiveOverlapped(opts: ArchiveOverlappedOptions): Promise<void> {
  const handle = await loadWorkspace();
  if (!handle) process.exit(1);
  const { store, workspaceId } = handle;
  const overlapHours = resolveOverlapHours(opts.overlapHours);
  const overlapMs = overlapHours * 3600 * 1000;
  const archived = store.archiveOverlapped(workspaceId, overlapMs);
  store.close();
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        workspace_id: workspaceId,
        overlap_hours: overlapHours,
        archived_count: archived.length,
        archived_key_ids: archived,
      })}\n`,
    );
    return;
  }
  if (archived.length === 0) {
    success(`No DEKs past the ${overlapHours}h overlap window for ${chalk.bold(workspaceId)}.`);
    return;
  }
  success(`Archived ${archived.length} DEK(s) past the ${overlapHours}h overlap window:`);
  for (const k of archived) line(`  ${k}`);
}

function resolveOverlapHours(flagValue?: string): number {
  if (flagValue !== undefined) {
    const n = Number(flagValue);
    if (!Number.isFinite(n) || n <= 0) {
      fail(`--overlap-hours must be a positive number (got "${flagValue}")`);
      process.exit(1);
    }
    return n;
  }
  const envValue = process.env.WOTW_DEK_OVERLAP_HOURS;
  if (envValue) {
    const n = Number(envValue);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 24;
}
