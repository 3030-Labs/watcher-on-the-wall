/**
 * `wotw logs` — tail the daemon log file.
 *
 * Two modes:
 *   - Default: print the last N lines (default 20) and exit.
 *   - `--follow` / `-f`: print the last N lines, then stream new lines
 *     as the daemon writes them. Exits cleanly on SIGINT/SIGTERM.
 *
 * The command opens the file directly rather than going through the
 * running daemon — this way the operator can read logs even if the
 * daemon is stopped or crashed. We read in 64KB chunks from the end of
 * the file so very large logs don't blow up memory.
 */
import type { Command } from "commander";
import {
  existsSync,
  openSync,
  readSync,
  statSync,
  closeSync,
  watchFile,
  unwatchFile,
} from "node:fs";
import { loadConfig, resolveConfigPaths } from "../../daemon/config.js";
import { errorLine, line, warn } from "../output.js";

interface LogsOptions {
  follow?: boolean;
  lines?: string;
}

/** Default number of lines to print when neither `--lines` nor `--follow` are given. */
const DEFAULT_LINES = 20;

/** Read chunk size when tailing from the end of the file. */
const TAIL_CHUNK = 64 * 1024;

/**
 * Attach the `logs` subcommand.
 */
export function registerLogsCommand(program: Command): void {
  program
    .command("logs")
    .description("Tail the daemon log file")
    .option("-f, --follow", "Follow new log lines as they are written")
    .option("-n, --lines <count>", "Number of trailing lines to print (default 20)")
    .action(async (opts: LogsOptions) => {
      await runLogs(opts);
    });
}

/**
 * CLI entry point. Resolves the daemon log file from config and prints
 * the last N lines, optionally following new writes.
 */
export async function runLogs(opts: LogsOptions): Promise<void> {
  const loaded = await loadConfig();
  const config = resolveConfigPaths(loaded.config);
  const logFile = config.daemon.log_file;

  const requestedLines = parseLines(opts.lines);
  if (requestedLines === null) {
    errorLine(`invalid --lines value: ${opts.lines}`);
    process.exit(1);
    return;
  }

  if (!existsSync(logFile)) {
    warn(`no log file at ${logFile}. Start the daemon first (wotw start).`);
    return;
  }

  // Print the tail once, unconditionally. In follow mode we then hook
  // a watcher for new writes; in default mode we return immediately.
  const startSize = printLastLines(logFile, requestedLines);

  if (opts.follow !== true) return;

  await followLog(logFile, startSize);
}

/**
 * Parse a `--lines <count>` option. Returns the DEFAULT_LINES value when
 * the option is unset, or `null` for invalid input so the caller can
 * surface a clean error message.
 */
function parseLines(raw: string | undefined): number | null {
  if (raw === undefined) return DEFAULT_LINES;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

/**
 * Print the last `count` lines of `filePath` to stdout. Reads from the
 * end of the file in fixed-size chunks so we don't load the whole log
 * into memory on a large file. Returns the file size at the time we
 * finished reading, so the follow-mode caller can resume from there.
 */
function printLastLines(filePath: string, count: number): number {
  const stat = statSync(filePath);
  const size = stat.size;
  if (count === 0 || size === 0) return size;

  const fd = openSync(filePath, "r");
  try {
    let readStart = Math.max(0, size - TAIL_CHUNK);
    let chunk = Buffer.alloc(0);
    // Keep growing the chunk backwards until we have `count` newlines
    // or we've read the whole file.
    // Worst-case this still bounds at `size` bytes because readStart
    // monotonically decreases to 0.
    while (true) {
      const len = size - readStart;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, readStart);
      chunk = buf;
      const newlines = countNewlines(chunk);
      if (newlines >= count || readStart === 0) break;
      readStart = Math.max(0, readStart - TAIL_CHUNK);
    }
    const text = chunk.toString("utf8");
    const lines = text.split("\n");
    // If the final line is empty (file ends with \n) drop it so we
    // don't print an extra blank line.
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    const tail = lines.slice(-count);
    for (const l of tail) line(l);
  } finally {
    closeSync(fd);
  }
  return size;
}

/**
 * Follow `filePath` for new writes after `fromOffset`. Uses {@link watchFile}
 * (poll-based, 250ms) so it works identically across platforms (including
 * WSL where inotify on /home sometimes misses events). Stops cleanly on
 * SIGINT / SIGTERM. Returns a promise that resolves only on shutdown.
 */
async function followLog(filePath: string, fromOffset: number): Promise<void> {
  let currentOffset = fromOffset;
  let stopped = false;

  const readNew = (): void => {
    try {
      const stat = statSync(filePath);
      // Handle log rotation: if the file shrank, start over from the
      // beginning of the new file.
      if (stat.size < currentOffset) {
        currentOffset = 0;
      }
      if (stat.size === currentOffset) return;
      const fd = openSync(filePath, "r");
      try {
        const len = stat.size - currentOffset;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, currentOffset);
        const text = buf.toString("utf8");
        // Strip the trailing newline so we don't emit a blank line.
        const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
        if (trimmed.length > 0) line(trimmed);
        currentOffset = stat.size;
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      errorLine(`log read failed: ${(err as Error).message}`);
    }
  };

  watchFile(filePath, { interval: 250 }, () => {
    if (!stopped) readNew();
  });

  await new Promise<void>((resolve) => {
    const shutdown = (): void => {
      stopped = true;
      unwatchFile(filePath);
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

/** Count the number of `\n` bytes in a buffer. Faster than toString+split. */
function countNewlines(buf: Buffer): number {
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}
