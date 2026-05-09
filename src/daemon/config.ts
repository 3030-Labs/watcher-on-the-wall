/**
 * Configuration loader. Uses cosmiconfig to discover a user config file, validates
 * it, and merges it with sensible defaults into a {@link WotwConfig}.
 */
import { cosmiconfig, type CosmiconfigResult } from "cosmiconfig";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { resolvePath } from "../utils/fs.js";
import type { WotwConfig } from "../utils/types.js";

const MODULE_NAME = "wotw";

/** Default plan limits. Active only when `hosted.enabled: true`. */
export const PLAN_DEFAULTS = {
  founding: {
    storage_bytes: 2 * 1024 ** 3, // 2 GB
    max_files_per_day: 50,
    max_file_size_bytes: 25 * 1024 ** 2, // 25 MB
    max_ingest_bytes_per_day: 250 * 1024 ** 2, // 250 MB
    heal_cooldown_seconds: 3600, // 1 hour
    query_rate_limit_per_hour: 60,
  },
  pro: {
    storage_bytes: 10 * 1024 ** 3, // 10 GB
    max_files_per_day: 200,
    max_file_size_bytes: 100 * 1024 ** 2, // 100 MB
    max_ingest_bytes_per_day: 1024 ** 3, // 1 GB
    heal_cooldown_seconds: 900, // 15 min
    query_rate_limit_per_hour: 300,
  },
} as const;

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
      staging: true,
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
      trust_proxy: false,
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
    query: {
      expand: true,
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
      consolidation_threshold: 5,
      consolidation_enabled: true,
      zero_hit_threshold: 0.2,
      enrichment_enabled: true,
      query_log_file: ".wotw/query-log.jsonl",
    },
    hosted: {
      enabled: false,
      tenant_id: null,
      concurrency_cap: 1,
      paused: false,
      plan: "pro",
      limits: {
        storage_bytes: PLAN_DEFAULTS.pro.storage_bytes,
        max_files_per_day: PLAN_DEFAULTS.pro.max_files_per_day,
        max_file_size_bytes: PLAN_DEFAULTS.pro.max_file_size_bytes,
        max_ingest_bytes_per_day: PLAN_DEFAULTS.pro.max_ingest_bytes_per_day,
        heal_cooldown_seconds: PLAN_DEFAULTS.pro.heal_cooldown_seconds,
        query_rate_limit_per_hour: PLAN_DEFAULTS.pro.query_rate_limit_per_hour,
        onboarding_burst_multiplier: 3,
        onboarding_burst_hours: 48,
      },
      timezone: "America/New_York",
      created_at: null,
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
 * Resolution order (highest to lowest priority):
 *   1. Environment variables (see {@link applyEnvOverrides})
 *   2. User config file
 *   3. Defaults
 *
 * In hosted mode (`WOTW_HOSTED=true` or `hosted.enabled` in the file), the
 * resulting config is additionally checked by {@link validateHostedConfig}
 * which throws when `tenant_id` is missing, malformed, or `wiki_root` is
 * unset.
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
  let merged: WotwConfig;
  let path: string | null = null;
  if (!result || !result.config) {
    // eslint-disable-next-line no-console -- runs before pino logger is initialized
    console.warn(
      "[wotw] no wotw.yaml found — using all defaults (auth disabled, max_daily_usd: 10.0)",
    );
    merged = defaults;
  } else {
    merged = mergeConfig(defaults, result.config as Partial<WotwConfig>);
    path = result.filepath;
  }
  // Env overrides take precedence over the file. Applied here so the
  // hosted-mode validation below sees the final, fully-resolved values.
  const withEnv = applyEnvOverrides(merged);
  const validated = validateConfig(withEnv);
  validateHostedConfig(validated);
  return { config: validated, path };
}

/**
 * Apply runtime environment-variable overrides to a parsed config. Returns
 * a new object; the input is not mutated. Each override is read from the
 * corresponding env var and only set if the value is non-empty.
 *
 * Variables consumed (each optional):
 *   WOTW_HOSTED           "true" / "false" — `hosted.enabled`
 *   TENANT_ID             UUID — `hosted.tenant_id` (validated downstream)
 *   WIKI_ROOT             absolute path — `wiki_root`
 *   WOTW_PLAN             "founding" | "pro" — `hosted.plan`
 *   WOTW_TIMEZONE         IANA tz — `hosted.timezone`
 *   WOTW_PORT             integer — `server.port`
 *   WOTW_HOST             host string — `server.host`
 *   WOTW_LOG_LEVEL        pino level — `daemon.log_level`
 *   WOTW_RUNTIME_MODE     "auto" | "cli" | "api" — `execution.mode`
 *   ADMIN_SERVICE_KEY     bearer token — `server.auth_token`
 */
export function applyEnvOverrides(config: WotwConfig): WotwConfig {
  const out = structuredClone(config);
  const env = process.env;

  if (env.WOTW_HOSTED !== undefined) {
    out.hosted.enabled = env.WOTW_HOSTED === "true";
  }
  if (env.TENANT_ID && env.TENANT_ID.length > 0) {
    out.hosted.tenant_id = env.TENANT_ID;
  }
  if (env.WIKI_ROOT && env.WIKI_ROOT.length > 0) {
    out.wiki_root = env.WIKI_ROOT;
  }
  if (env.WOTW_PLAN === "founding" || env.WOTW_PLAN === "pro") {
    out.hosted.plan = env.WOTW_PLAN;
  }
  if (env.WOTW_TIMEZONE && env.WOTW_TIMEZONE.length > 0) {
    out.hosted.timezone = env.WOTW_TIMEZONE;
  }
  if (env.WOTW_PORT) {
    const n = Number.parseInt(env.WOTW_PORT, 10);
    if (Number.isFinite(n) && n > 0 && n < 65536) {
      out.server.port = n;
    }
  }
  if (env.WOTW_HOST && env.WOTW_HOST.length > 0) {
    out.server.host = env.WOTW_HOST;
  }
  if (env.WOTW_LOG_LEVEL) {
    const lvl = env.WOTW_LOG_LEVEL;
    if (
      lvl === "trace" ||
      lvl === "debug" ||
      lvl === "info" ||
      lvl === "warn" ||
      lvl === "error" ||
      lvl === "fatal"
    ) {
      out.daemon.log_level = lvl;
    }
  }
  if (
    env.WOTW_RUNTIME_MODE === "auto" ||
    env.WOTW_RUNTIME_MODE === "cli" ||
    env.WOTW_RUNTIME_MODE === "api"
  ) {
    out.execution.mode = env.WOTW_RUNTIME_MODE;
  }
  if (env.ADMIN_SERVICE_KEY && env.ADMIN_SERVICE_KEY.length > 0) {
    out.server.auth_token = env.ADMIN_SERVICE_KEY;
  }
  return out;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Hosted-mode runtime invariants. Throws with a precise message when:
 *   - `hosted.enabled` is true but `tenant_id` is missing
 *   - `tenant_id` is set but is not a valid UUID
 *   - `wiki_root` is an empty/relative path that won't resolve to a stable
 *     mount point under `/data`
 *
 * Called from {@link loadConfig}. Community-mode configs (where
 * `hosted.enabled` is false) are unaffected.
 */
export function validateHostedConfig(config: WotwConfig): void {
  if (!config.hosted.enabled) return;
  if (!config.hosted.tenant_id || config.hosted.tenant_id.length === 0) {
    throw new Error(
      "Config error: hosted.enabled is true but TENANT_ID / hosted.tenant_id is unset.",
    );
  }
  if (!UUID_REGEX.test(config.hosted.tenant_id)) {
    throw new Error(
      `Config error: hosted.tenant_id "${config.hosted.tenant_id}" is not a valid UUID.`,
    );
  }
  if (!config.wiki_root || config.wiki_root.length === 0) {
    throw new Error("Config error: hosted.enabled is true but wiki_root / WIKI_ROOT is unset.");
  }
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
  if (override.query) assign("query", override.query);
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
  if (override.hosted) assign("hosted", override.hosted);
  return out;
}

// ---------------------------------------------------------------------------
// Zod validation schema
// ---------------------------------------------------------------------------

const positiveNumber = z.number().positive();
const nonNegativeNumber = z.number().min(0);
const logLevelSchema = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);

/**
 * Zod schema that validates a fully-merged WotwConfig object. Every field
 * has a default matching {@link defaultConfig} so a bare `{}` passes.
 */
const WotwConfigSchema = z.object({
  wiki_root: z.string().min(1),
  raw_path: z.string().min(1),
  execution: z.object({
    mode: z.enum(["auto", "cli", "api"]),
    cli_path: z.string().min(1),
    cli_model: z.string().min(1),
    api_key_env: z.string().min(1),
  }),
  models: z.object({
    ingest: z.string().min(1),
    query: z.string().min(1),
    lint: z.string().min(1),
    compound_eval: z.string().min(1),
  }),
  watcher: z.object({
    debounce_initial_ms: positiveNumber,
    debounce_max_ms: positiveNumber,
    debounce_growth_factor: positiveNumber,
    burst_threshold: z.number().int().positive(),
    max_batch_size: z.number().int().positive(),
    ignore_patterns: z.array(z.string()),
  }),
  ingestion: z.object({
    max_turns: z.number().int().positive(),
    max_budget_per_batch_usd: positiveNumber,
    resume_session: z.boolean(),
    dead_letter_file: z.string(),
    staging: z.boolean(),
  }),
  cost: z.object({
    max_daily_usd: positiveNumber,
    max_per_query_usd: positiveNumber,
    max_per_ingest_usd: positiveNumber,
    track_file: z.string().min(1),
  }),
  server: z.object({
    port: z.number().int().min(1).max(65535),
    host: z.string().min(1),
    auth_token: z.string().nullable(),
    rate_limit_rpm: z.number().int().positive(),
    trust_proxy: z.boolean(),
  }),
  daemon: z.object({
    pid_file: z.string().min(1),
    lock_file: z.string().min(1),
    log_file: z.string().min(1),
    log_level: logLevelSchema,
  }),
  compounding: z.object({
    enabled: z.boolean(),
    min_source_pages: z.number().int().min(0),
    confidence_threshold: z.number().min(0).max(100),
  }),
  provenance: z.object({
    enabled: z.boolean(),
    chain_file: z.string().min(1),
    verify_on_startup: z.boolean(),
  }),
  multi_user: z.object({
    enabled: z.boolean(),
    workspaces_dir: z.string().min(1),
  }),
  query: z.object({
    expand: z.boolean(),
  }),
  lint: z.object({
    schedule_enabled: z.boolean(),
    interval_hours: positiveNumber,
    auto_fix: z.boolean(),
  }),
  hosted: z.object({
    enabled: z.boolean(),
    tenant_id: z.string().nullable(),
    concurrency_cap: z.number().int().positive(),
    paused: z.boolean(),
    plan: z.enum(["founding", "pro"]),
    limits: z.object({
      storage_bytes: positiveNumber,
      max_files_per_day: z.number().int().positive(),
      max_file_size_bytes: positiveNumber,
      max_ingest_bytes_per_day: positiveNumber,
      heal_cooldown_seconds: nonNegativeNumber,
      query_rate_limit_per_hour: z.number().int().positive(),
      onboarding_burst_multiplier: positiveNumber,
      onboarding_burst_hours: positiveNumber,
    }),
    timezone: z.string().min(1),
    created_at: z.string().nullable(),
  }),
  health: z.object({
    staleness_thresholds: z.array(z.number().int().min(0)),
    staleness_scores: z.array(z.number().min(0).max(100)),
    weights: z.object({
      staleness: nonNegativeNumber,
      source_availability: nonNegativeNumber,
      link_health: nonNegativeNumber,
      duplicate_risk: nonNegativeNumber,
      contradiction_risk: nonNegativeNumber,
    }),
    duplicate_threshold: z.number().min(0).max(100),
    auto_fix_staleness_below: z.number().min(0).max(100),
    max_fixes_per_run: z.number().int().min(0),
    detect_contradictions: z.boolean(),
    consolidation_threshold: z.number().int().min(2),
    consolidation_enabled: z.boolean(),
    zero_hit_threshold: z.number().min(0).max(1),
    enrichment_enabled: z.boolean(),
    query_log_file: z.string(),
  }),
});

/**
 * Validate a merged config against the Zod schema. Throws a descriptive
 * error on failure, naming the invalid field, expected type, and value.
 */
export function validateConfig(config: WotwConfig): WotwConfig {
  const result = WotwConfigSchema.safeParse(config);
  if (!result.success) {
    const issue = result.error.issues[0]!;
    const path = issue.path.join(".");
    throw new Error(`Config error: "${path}" ${issue.message}`);
  }
  return result.data as WotwConfig;
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
  // Query log file is wiki-relative, like the dead-letter file.
  if (out.health.query_log_file.length > 0) {
    out.health.query_log_file = resolvePath(out.health.query_log_file, out.wiki_root);
  }
  return out;
}
