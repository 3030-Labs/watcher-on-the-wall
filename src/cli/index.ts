/**
 * Commander.js entrypoint for the `wotw` CLI. Registers all subcommands and
 * dispatches to their implementations.
 *
 * Special case: if this process was spawned with WOTW_DAEMON_CHILD=1 in the
 * environment (via `child_process.spawn` with `detached: true` and
 * `stdio: 'ignore'` — see decision D-16), it immediately hands control to
 * the daemon entry module. This keeps a single compiled entrypoint while
 * still supporting detached daemon spawning.
 */
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerStartCommand } from "./commands/start.js";
import { registerStopCommand } from "./commands/stop.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerQueryCommand } from "./commands/query.js";
import { registerAuditCommand } from "./commands/audit.js";
import { registerLintCommand } from "./commands/lint.js";
import { registerLogsCommand } from "./commands/logs.js";
import { registerInstallHookCommand } from "./commands/install-hook.js";
import { registerUninstallHookCommand } from "./commands/uninstall-hook.js";
import { registerServeCommand } from "./commands/serve.js";
import { registerSynthesizeCommand } from "./commands/synthesize.js";
import { registerSearchCommand } from "./commands/search.js";
import { registerStaleCommand } from "./commands/stale.js";
import { registerUserCommand } from "./commands/user.js";
import { registerApproveCommand } from "./commands/approve.js";
import { registerRejectCommand } from "./commands/reject.js";
import { registerCandidatesCommand } from "./commands/candidates.js";

const VERSION = "0.2.0";

async function main(): Promise<void> {
  // If spawned as a detached daemon child (D-16), bypass CLI parsing entirely.
  if (process.env.WOTW_DAEMON_CHILD === "1") {
    await import("../daemon/entry.js");
    return;
  }

  const program = new Command();
  program
    .name("wotw")
    .description("watcher-on-the-wall — a self-bootstrapping persistent AI knowledge daemon")
    .version(VERSION, "-v, --version", "Print the version and exit")
    .helpOption("-h, --help", "Show help")
    .showHelpAfterError();

  registerInitCommand(program);
  registerStartCommand(program);
  registerStopCommand(program);
  registerStatusCommand(program);
  registerQueryCommand(program);
  registerSearchCommand(program);
  registerAuditCommand(program);
  registerLintCommand(program);
  registerLogsCommand(program);
  registerInstallHookCommand(program);
  registerUninstallHookCommand(program);
  registerServeCommand(program);
  registerStaleCommand(program);
  registerSynthesizeCommand(program);
  registerUserCommand(program);
  registerApproveCommand(program);
  registerRejectCommand(program);
  registerCandidatesCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
  // Last-ditch error handler — anything that propagates this far is a bug.
  process.stderr.write(`fatal: ${(err as Error).message}\n`);
  if (process.env.WOTW_DEBUG === "1") {
    process.stderr.write(`${(err as Error).stack ?? ""}\n`);
  }
  process.exit(1);
});
