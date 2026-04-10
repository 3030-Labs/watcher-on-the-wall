/**
 * Pretty terminal output helpers wrapping chalk, boxen, and ora. All CLI commands
 * should emit user-visible output through this module; debug output goes through
 * pino via {@link getLogger}.
 */
import boxen, { type Options as BoxenOptions } from "boxen";
import chalk from "chalk";
import ora, { type Ora } from "ora";

const stdout = process.stdout;
const stderr = process.stderr;

/** Write a raw line to stdout. */
export function line(text = ""): void {
  stdout.write(`${text}\n`);
}

/** Write an error line to stderr. */
export function errorLine(text: string): void {
  stderr.write(`${text}\n`);
}

/** Success message in green. */
export function success(text: string): void {
  line(`${chalk.green("✔")} ${text}`);
}

/** Info message in blue. */
export function info(text: string): void {
  line(`${chalk.cyan("ℹ")} ${text}`);
}

/** Warning message in yellow. */
export function warn(text: string): void {
  line(`${chalk.yellow("⚠")} ${text}`);
}

/** Failure message in red. */
export function fail(text: string): void {
  errorLine(`${chalk.red("✖")} ${text}`);
}

/** Start a spinner with a given title. */
export function spinner(title: string): Ora {
  return ora({ text: title, color: "cyan" }).start();
}

/** Render a framed box around content. */
export function box(content: string, title?: string): void {
  const opts: BoxenOptions = {
    padding: 1,
    borderStyle: "round",
    borderColor: "cyan",
    ...(title ? { title, titleAlignment: "center" } : {}),
  };
  stdout.write(`${boxen(content, opts)}\n`);
}

/** Render a two-column key/value table. */
export function keyValueTable(rows: Array<[string, string]>): string {
  const widest = rows.reduce((m, [k]) => Math.max(m, k.length), 0);
  return rows.map(([k, v]) => `${chalk.dim(k.padEnd(widest))}  ${v}`).join("\n");
}

/** Export chalk for call sites that need ad-hoc coloring. */
export { chalk };
