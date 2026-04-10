/**
 * Obsidian vault detection and launch helpers.
 *
 * Obsidian stores its vault registry in a platform-specific `obsidian.json`
 * file that maps hex IDs → `{ path, ts, open }`. We parse it best-effort;
 * any error (missing file, bad JSON, permission denied) just yields an empty
 * list so the init wizard falls back to manual entry.
 *
 * The launch helper uses the `obsidian://` URI scheme, which is registered
 * by the Obsidian desktop app on all three platforms. We dispatch through
 * `open` / `xdg-open` / `start` and return `false` on any failure — the
 * wizard reports a friendly "couldn't open automatically" note and moves on.
 */
import { exec } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";

/** A single Obsidian vault as surfaced by the registry. */
export interface ObsidianVault {
  /** Basename of the vault root, used as the display name. */
  name: string;
  /** Absolute path to the vault root. */
  path: string;
  /** Last-opened timestamp from the registry (ms since epoch). */
  ts: number;
  /** Whether the vault is currently marked open in the registry. */
  open: boolean;
}

/** Shape of a single entry in the `vaults` object of `obsidian.json`. */
interface ObsidianJsonVaultEntry {
  path?: unknown;
  ts?: unknown;
  open?: unknown;
}

/** Shape of the top-level `obsidian.json` file. */
interface ObsidianJson {
  vaults?: Record<string, ObsidianJsonVaultEntry>;
}

/**
 * Return the absolute path of Obsidian's per-user registry file. Exported
 * for tests so they can stub the location via the `override` parameter.
 */
export function obsidianRegistryPath(override?: string): string {
  if (override && override.length > 0) return override;
  const home = homedir();
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
    case "win32": {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "obsidian", "obsidian.json");
    }
    default:
      // Linux / WSL / BSDs — XDG_CONFIG_HOME if set, else ~/.config.
      return join(
        process.env.XDG_CONFIG_HOME ?? join(home, ".config"),
        "obsidian",
        "obsidian.json",
      );
  }
}

/**
 * Read the Obsidian registry and return every vault that still exists on
 * disk, sorted by last-opened timestamp descending. Any failure — missing
 * file, parse error, unreadable — returns an empty array.
 *
 * The `registryPath` argument is exposed for tests; production callers
 * should use the default.
 */
export function findObsidianVaults(registryPath?: string): ObsidianVault[] {
  const path = obsidianRegistryPath(registryPath);
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: ObsidianJson;
  try {
    parsed = JSON.parse(raw) as ObsidianJson;
  } catch {
    return [];
  }
  const vaults = parsed.vaults ?? {};
  const out: ObsidianVault[] = [];
  for (const entry of Object.values(vaults)) {
    if (!entry || typeof entry !== "object") continue;
    const p = entry.path;
    if (typeof p !== "string" || p.length === 0) continue;
    if (!existsSync(p)) continue;
    try {
      if (!statSync(p).isDirectory()) continue;
    } catch {
      continue;
    }
    out.push({
      name: basename(p),
      path: p,
      ts: typeof entry.ts === "number" ? entry.ts : 0,
      open: entry.open === true,
    });
  }
  out.sort((a, b) => b.ts - a.ts);
  return out;
}

/**
 * Walk up from `dir` looking for a directory that contains `.obsidian/`.
 * Returns the vault root (the directory that holds `.obsidian/`) or null
 * if none is found before reaching the filesystem root.
 */
export function findEnclosingVault(dir: string): string | null {
  let current = resolve(dir);
  // Guard against symlink loops / pathological input by bounding the walk.
  for (let i = 0; i < 64; i += 1) {
    const candidate = join(current, ".obsidian");
    try {
      if (statSync(candidate).isDirectory()) return current;
    } catch {
      // not a directory at this level, keep walking
    }
    const parent = dirname(current);
    if (parent === current) return null;
    const parsed = parse(current);
    if (current === parsed.root) return null;
    current = parent;
  }
  return null;
}

/**
 * Platform-specific command used to hand an `obsidian://` URI off to the
 * registered handler. Exported so tests can snapshot the command without
 * actually spawning anything.
 */
export function obsidianOpenCommand(vaultPath: string): { command: string; args: string[] } {
  const uri = `obsidian://open?path=${encodeURIComponent(vaultPath)}`;
  switch (platform()) {
    case "darwin":
      return { command: "open", args: [uri] };
    case "win32":
      // `start` is a cmd.exe builtin — invoke via cmd /c. The empty title
      // argument is required because `start` treats the first quoted arg
      // as a window title.
      return { command: "cmd", args: ["/c", "start", "", uri] };
    default:
      return { command: "xdg-open", args: [uri] };
  }
}

/**
 * Launch Obsidian on the given vault path via the `obsidian://open` URI.
 * Returns true if the launcher command exited 0, false on any failure
 * (command not found, non-zero exit, timeout). Never throws.
 */
export async function openInObsidian(vaultPath: string): Promise<boolean> {
  const { command, args } = obsidianOpenCommand(vaultPath);
  // Quote each arg defensively. `exec` runs through /bin/sh (or cmd.exe on
  // Windows) so we must escape. We only pass constants + an encoded URI
  // so there is no user-controlled injection surface, but quoting keeps
  // shells that interpret `?` or `&` happy.
  const quoted = [command, ...args.map(shellQuote)].join(" ");
  return await new Promise<boolean>((resolvePromise) => {
    const child = exec(quoted, { timeout: 5000 }, (err) => {
      resolvePromise(err === null || err === undefined);
    });
    child.on("error", () => resolvePromise(false));
  });
}

/**
 * Tiny shell-quoting helper. On Windows we fall back to double quotes;
 * everywhere else we use single quotes with the standard `'\''` escape.
 */
function shellQuote(arg: string): string {
  if (arg.length === 0) return `''`;
  if (platform() === "win32") {
    // cmd.exe double-quote: escape embedded quotes.
    return `"${arg.replace(/"/g, '\\"')}"`;
  }
  // POSIX shells: wrap in single quotes, escape embedded single quotes.
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
