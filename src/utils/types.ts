/**
 * Shared type definitions used across the watcher-on-the-wall codebase.
 */

/** Supported LLM model identifiers. Kept loose so consumers can supply new IDs. */
export type ModelId = string;

/** Operation type for an ingestion / provenance record. */
export type OperationType = "ingest" | "query" | "compound" | "archive" | "lint" | "merge" | "heal";

/**
 * Execution mode. Controls which Claude runtime the daemon invokes:
 *
 *   - `auto`: detect at startup — prefer the Claude Code CLI binary on PATH,
 *     fall back to the Agent SDK if ANTHROPIC_API_KEY is set.
 *   - `cli`: always spawn the `claude` CLI. Free with an existing Claude Pro/Max
 *     subscription. All operations use `execution.cli_model`.
 *   - `api`: always use the Agent SDK. Requires ANTHROPIC_API_KEY. Operations
 *     use the model-router (Haiku for ingest, Sonnet for query, etc.).
 */
export type ExecutionMode = "auto" | "cli" | "api";

/** Resolved runtime mode — what the daemon actually ended up using. */
export type RuntimeMode = "cli" | "api";

/** Confidence level for wiki entries. */
export type ConfidenceLevel = "high" | "medium" | "low";

/** Category of a wiki page. */
export type WikiCategory = "concept" | "entity" | "source" | "comparison" | "synthesis" | "query";

/** Resolved configuration values with all defaults applied. */
export interface WotwConfig {
  wiki_root: string;
  raw_path: string;
  execution: {
    /** How to choose the LLM runtime. See {@link ExecutionMode}. */
    mode: ExecutionMode;
    /** Path (or bare name) of the Claude Code CLI binary. */
    cli_path: string;
    /** Model used for ALL operations when running in CLI mode. */
    cli_model: ModelId;
    /** Name of the env var to read the Anthropic API key from in API mode. */
    api_key_env: string;
  };
  models: {
    ingest: ModelId;
    query: ModelId;
    lint: ModelId;
    compound_eval: ModelId;
  };
  watcher: {
    debounce_initial_ms: number;
    debounce_max_ms: number;
    debounce_growth_factor: number;
    burst_threshold: number;
    max_batch_size: number;
    ignore_patterns: string[];
  };
  ingestion: {
    max_turns: number;
    max_budget_per_batch_usd: number;
    resume_session: boolean;
    /**
     * File where permanently-failed batches are recorded (one JSON object
     * per line). Resolved relative to {@link WotwConfig.wiki_root} at
     * config-load time. Set to an empty string to disable.
     */
    dead_letter_file: string;
    /**
     * When true, ingested pages land in `wiki/candidates/` for human review
     * instead of going directly into category directories. Approved via
     * `wotw approve`, rejected via `wotw reject`.
     */
    staging: boolean;
  };
  cost: {
    max_daily_usd: number;
    max_per_query_usd: number;
    max_per_ingest_usd: number;
    track_file: string;
  };
  server: {
    port: number;
    host: string;
    auth_token: string | null;
    rate_limit_rpm: number;
    /**
     * When true, trust the `X-Forwarded-For` header for client IP
     * extraction (for rate limiting). Enable when running behind a
     * reverse proxy. Default false — use `req.socket.remoteAddress`.
     */
    trust_proxy: boolean;
  };
  daemon: {
    pid_file: string;
    lock_file: string;
    log_file: string;
    log_level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  };
  compounding: {
    enabled: boolean;
    min_source_pages: number;
    confidence_threshold: number;
  };
  provenance: {
    enabled: boolean;
    chain_file: string;
    verify_on_startup: boolean;
  };
  multi_user: {
    enabled: boolean;
    workspaces_dir: string;
  };
  query: {
    /** Enable LLM-powered query expansion before BM25 search. */
    expand: boolean;
  };
  lint: {
    /** If true, the daemon runs a lint pass on a recurring interval. */
    schedule_enabled: boolean;
    /** Interval between scheduled lint passes, in hours. */
    interval_hours: number;
    /** When true, scheduled lint runs with --fix semantics (auto-heal). */
    auto_fix: boolean;
  };
  health: {
    /** Day thresholds for staleness scoring (ascending). */
    staleness_thresholds: number[];
    /** Scores corresponding to each staleness bucket (one more than thresholds). */
    staleness_scores: number[];
    /** Scoring weights — must sum to 1.0. */
    weights: {
      staleness: number;
      source_availability: number;
      link_health: number;
      duplicate_risk: number;
      contradiction_risk: number;
    };
    /** Similarity score 0-100 above which pages are flagged as duplicates. */
    duplicate_threshold: number;
    /** Pages scoring below this on staleness are auto-fixable. */
    auto_fix_staleness_below: number;
    /** Cap LLM calls per lint --fix pass. */
    max_fixes_per_run: number;
    /** Enable LLM-powered contradiction detection (expensive). */
    detect_contradictions: boolean;
    /** Merge when a topic has more than N pages. */
    consolidation_threshold: number;
    /** Master switch for knowledge consolidation. */
    consolidation_enabled: boolean;
    /** Trigger vocabulary enrichment when zero-hit rate exceeds this (0-1). */
    zero_hit_threshold: number;
    /** Master switch for automated vocabulary enrichment. */
    enrichment_enabled: boolean;
    /** JSONL file for query logging. Resolved relative to wiki_root. */
    query_log_file: string;
  };
  /**
   * Hosted mode configuration. When `enabled: true`, the daemon runs in a
   * multi-tenant cloud environment with per-tenant scheduling, concurrency
   * caps, and kill switches. Default off — single-user mode unchanged.
   */
  hosted: {
    /** Master switch for hosted mode. Default false. */
    enabled: boolean;
    /** Tenant identifier, set by the cloud control plane. */
    tenant_id: string | null;
    /** Max concurrent jobs for this tenant. */
    concurrency_cap: number;
    /** Kill switch — when true, jobs are held (not dropped). */
    paused: boolean;
    /** Plan name — determines default limits. */
    plan: "founding" | "pro";
    /** Per-tenant resource limits. */
    limits: {
      storage_bytes: number;
      max_files_per_day: number;
      max_file_size_bytes: number;
      max_ingest_bytes_per_day: number;
      heal_cooldown_seconds: number;
      query_rate_limit_per_hour: number;
      onboarding_burst_multiplier: number;
      onboarding_burst_hours: number;
    };
    /** Timezone for daily limit resets. */
    timezone: string;
    /** Workspace creation time (ISO string) for burst calculation. */
    created_at: string | null;
  };
}

/**
 * Page lifecycle status. Present on orphaned pages whose source files
 * have been deleted from `raw/`. Pages without a `status` field are
 * considered active.
 */
export type WikiPageStatus = "orphaned" | "merged" | "stale" | "consolidated";

/** Wiki page frontmatter shape. */
export interface WikiFrontmatter {
  title: string;
  category: WikiCategory;
  created: string;
  updated: string;
  sources: string[];
  related: string[];
  tags: string[];
  confidence: ConfidenceLevel;
  /**
   * Optional lifecycle status. Set to `"orphaned"` when every source
   * file that fed this page has been deleted. Never auto-cleared — a
   * later ingestion that touches the page overwrites the frontmatter
   * wholesale, which drops the orphaned fields.
   */
  status?: WikiPageStatus;
  /** ISO-8601 UTC timestamp when the page was first marked orphaned. */
  orphaned_at?: string;
  /**
   * Wiki-root-relative source paths whose deletion orphaned this page.
   * Appended-to (deduplicated) when multiple sources are deleted across
   * different batches.
   */
  orphaned_source?: string[];
  /** Wiki-relative path of the page this was merged into (dedup heal). */
  merged_into?: string;
  /** Unresolved factual contradictions detected by the health system. */
  contradictions?: string[];
  /** ISO-8601 timestamp of last compilation by the ingestion pipeline. */
  last_compiled?: string;
  /** Number of raw source files backing this page. */
  source_count?: number;
  /** ISO-8601 timestamp of last source confirmation (re-ingest or corroboration). */
  last_confirmed?: string;
  /** Wiki-relative path of a page that supersedes this one, or null. */
  superseded_by?: string | null;
  /** ISO-8601 timestamp when this candidate page was rejected. */
  rejected_at?: string;
  /** Reason provided when rejecting a candidate page. */
  rejection_note?: string;
  /** Broad knowledge domain (e.g. "ops", "security", "architecture"). */
  domain?: string;
  /** Project or organizational context scope (e.g. project name, "general"). */
  scope?: string;
  /** Keywords and phrases for search findability, including synonyms. */
  key_terms?: string[];
  /** Wiki-relative path of the consolidated page this was merged into. */
  consolidated_into?: string;
}

/** A parsed wiki page. */
export interface WikiPage {
  path: string;
  frontmatter: WikiFrontmatter;
  body: string;
  raw: string;
}

/** A batch of files to be ingested together. */
export interface IngestionBatch {
  id: string;
  created_at: string;
  files: string[];
  reason: "initial" | "new" | "update";
}

/** Provenance record schema. */
export interface ProvenanceRecord {
  id: string;
  seq: number;
  timestamp: string;
  type: OperationType;
  source_files: string[];
  source_hashes: string[];
  prompt_hash: string;
  model_id: ModelId;
  response_hash: string;
  wiki_files_written: string[];
  wiki_file_hashes_after: Record<string, string>;
  merkle_root?: string;
  previous_id: string | null;
  previous_chain_hash: string;
  chain_hash: string;
  metadata?: Record<string, string | number | boolean>;
}

/** A cost log entry persisted one-per-line. */
export interface CostLogEntry {
  timestamp: string;
  operation: OperationType;
  model_id: ModelId;
  cost_usd: number;
  input_tokens?: number;
  output_tokens?: number;
  batch_id?: string;
}

/** Daemon status payload. */
export interface DaemonStatus {
  running: boolean;
  pid: number | null;
  started_at: string | null;
  uptime_seconds: number | null;
  config_path: string | null;
  wiki_root: string;
  server: { host: string; port: number; reachable: boolean };
  stats: {
    wiki_pages: number;
    provenance_records: number;
    pending_batches: number;
    cost_today_usd: number;
  };
}

/** An event emitted by the daemon. */
export type DaemonEvent =
  | { type: "FileDetected"; path: string; timestamp: string }
  | { type: "BatchQueued"; batch_id: string; file_count: number; timestamp: string }
  | { type: "IngestionStarted"; batch_id: string; timestamp: string }
  | {
      type: "IngestionComplete";
      batch_id: string;
      wiki_files_written: string[];
      cost_usd: number;
      timestamp: string;
    }
  | { type: "QueryReceived"; query: string; client: string; timestamp: string }
  | {
      type: "QueryAnswered";
      query: string;
      sources_used: number;
      cost_usd: number;
      timestamp: string;
    }
  | { type: "CompoundFiled"; page: string; sources: string[]; timestamp: string }
  | { type: "Error"; phase: string; error: string; timestamp: string };
