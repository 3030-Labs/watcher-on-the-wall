/**
 * Configuration loader. Uses cosmiconfig to discover a user config file, validates
 * it, and merges it with sensible defaults into a {@link WotwConfig}.
 */
import { cosmiconfig, type CosmiconfigResult } from "cosmiconfig";
import { parse as parseYaml } from "yaml";
import { resolvePath } from "../utils/fs.js";
import type { WotwConfig } from "../utils/types.js";

const MODULE_NAME = "wotw";

/**
 * Default configuration applied when no file is found (or when fields are missing).
 */
export function defaultConfig(): WotwConfig {
  return {
    wiki_root: "./wiki-store",
    raw_path: "./wiki-store/raw",
    execution: {
      mode: "auto",
      cli_path: "claude",
      cli_model: "claude-sonnet-4-5",
      api_key_env: "ANTHROPIC_API_KEY",
    },
    models: {
      ingest: "claude-haiku-4-5",
      query: "claude-sonnet-4-5",
      lint: "claude-sonnet-4-5",
      compound_eval: "claude-haiku-4-5",
    },
    watcher: {
      debounce_initial_ms: 5000,
      debounce_max_ms: 60000,
      debounce_growth_factor: 1.5,
      burst_threshold: 5,
      max_batch_size: 20,
      ignore_patterns: ["**/.git/**", "**/node_modules/**", "**/.DS_Store", "**/Thumbs.db"],
    },
    ingestion: {
      max_turns: 50,
      max_budget_per_batch_usd: 1.0,
      resume_session: true,
      dead_letter_file: ".wotw/failed-batches.jsonl",
    },
    cost: {
      max_daily_usd: 10.0,
      max_per_query_usd: 0.5,
      max_per_ingest_usd: 2.0,
      track_file: "~/.wotw/cost-log.jsonl",
    },
    server: {
      port: 8787,
      host: "127.0.0.1",
      auth_token: null,
      rate_limit_rpm: 60,
    },
    daemon: {
      pid_file: "~/.wotw/daemon.pid",
      lock_file: "~/.wotw/daemon.lock",
      log_file: "~/.wotw/daemon.log",
      log_level: "info",
    },
    compounding: {
      enabled: true,
      min_source_pages: 3,
      confidence_threshold: 70,
    },
    provenance: {
      enabled: true,
      chain_file: "provenance-chain.jsonl",
      verify_on_startup: false,
    },
    multi_user: {
      enabled: false,
      workspaces_dir: "~/.wotw/workspaces",
    },
    lint: {
      schedule_enabled: false,
      interval_hours: 24,
      auto_fix: false,
    },
    health: {
      staleness_thresholds: [7, 30, 90, 180, 365],
      staleness_scores: [100, 80, 60, 40, 20, 0],
      weights: {
        staleness: 0.25,
        source_availability: 0.25,
        link_health: 0.2,
        duplicate_risk: 0.15,
        contradiction_risk: 0.15,
      },
      duplicate_threshold: 60,
      auto_fix_staleness_below: 40,
      max_fixes_per_run: 10,
      detect_contradictions: false,
    },
  };
}

/** Result of loading config: resolved value and origin path (if any). */
export interface LoadConfigResult {
  config: WotwConfig;
  path: string | null;
}

/**
 * Load configuration from cosmiconfig's discovery of `wotw.config.*`, `.wotwrc`, or
 * a `wotw` key in package.json. If no file is found, the default config is returned.
 *
 * @param searchFrom optional directory to search from (defaults to process.cwd())
 */
export async function loadConfig(searchFrom?: string): Promise<LoadConfigResult> {
  const explorer = cosmiconfig(MODULE_NAME, {
    searchPlaces: [
      "package.json",
      `.${MODULE_NAME}rc`,
      `.${MODULE_NAME}rc.json`,
      `.${MODULE_NAME}rc.yaml`,
      `.${MODULE_NAME}rc.yml`,
      `${MODULE_NAME}.config.json`,
      `${MODULE_NAME}.config.yaml`,
      `${MODULE_NAME}.config.yml`,
    ],
    loaders: {
      ".yaml": (_filepath, content) => parseYaml(content) as unknown,
      ".yml": (_filepath, content) => parseYaml(content) as unknown,
    },
  });

  const result: CosmiconfigResult = await explorer.search(searchFrom ?? process.cwd());
  const defaults = defaultConfig();
  if (!result || !result.config) {
    return { config: defaults, path: null };
  }
  return {
    config: mergeConfig(defaults, result.config as Partial<WotwConfig>),
    path: result.filepath,
  };
}

/**
 * Deep-merge user config on top of defaults. Unknown keys in user config are dropped
 * to prevent typos from leaking into runtime behavior.
 */
export function mergeConfig(base: WotwConfig, override: Partial<WotwConfig>): WotwConfig {
  const out: WotwConfig = structuredClone(base);
  const assign = <K extends keyof WotwConfig>(key: K, value: Partial<WotwConfig[K]>): void => {
    out[key] = { ...(out[key] as object), ...(value as object) } as WotwConfig[K];
  };

  if (override.wiki_root !== undefined) out.wiki_root = override.wiki_root;
  if (override.raw_path !== undefined) out.raw_path = override.raw_path;
  if (override.execution) assign("execution", override.execution);
  if (override.models) assign("models", override.models);
  if (override.watcher) assign("watcher", override.watcher);
  if (override.ingestion) assign("ingestion", override.ingestion);
  if (override.cost) assign("cost", override.cost);
  if (override.server) assign("server", override.server);
  if (override.daemon) assign("daemon", override.daemon);
  if (override.compounding) assign("compounding", override.compounding);
  if (override.provenance) assign("provenance", override.provenance);
  if (override.multi_user) assign("multi_user", override.multi_user);
  if (override.lint) assign("lint", override.lint);
  if (override.health) {
    // Deep-merge the weights sub-object separately.
    const healthBase = out.health;
    const healthOverride = override.health as Partial<WotwConfig["health"]>;
    out.health = { ...healthBase, ...healthOverride };
    if (healthOverride.weights) {
      out.health.weights = { ...healthBase.weights, ...healthOverride.weights };
    }
  }
  return out;
}

/**
 * Expand all path-like fields in a config using {@link resolvePath}.
 * Returns a new config; the input is not mutated.
 */
export function resolveConfigPaths(config: WotwConfig, baseDir?: string): WotwConfig {
  const out = structuredClone(config);
  out.wiki_root = resolvePath(out.wiki_root, baseDir);
  out.raw_path = resolvePath(out.raw_path, baseDir);
  out.cost.track_file = resolvePath(out.cost.track_file, baseDir);
  out.daemon.pid_file = resolvePath(out.daemon.pid_file, baseDir);
  out.daemon.lock_file = resolvePath(out.daemon.lock_file, baseDir);
  out.daemon.log_file = resolvePath(out.daemon.log_file, baseDir);
  out.multi_user.workspaces_dir = resolvePath(out.multi_user.workspaces_dir, baseDir);
  // Provenance chain lives inside the wiki root by default — resolve it
  // against the (already resolved) wiki_root so a relative default like
  // `provenance-chain.jsonl` lands in the right place.
  out.provenance.chain_file = resolvePath(out.provenance.chain_file, out.wiki_root);
  // Dead-letter file is likewise wiki-relative (so each wiki has its own
  // failure ledger). Empty string disables; leave it alone in that case.
  if (out.ingestion.dead_letter_file.length > 0) {
    out.ingestion.dead_letter_file = resolvePath(out.ingestion.dead_letter_file, out.wiki_root);
  }
  return out;
}
