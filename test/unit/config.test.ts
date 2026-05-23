/**
 * Unit tests for daemon/config.ts: defaults, deep-merge, path resolution,
 * and cosmiconfig-based loadConfig() composition.
 */
import { describe, expect, it, afterAll } from "vitest";
import { isAbsolute, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  applyEnvOverrides,
  defaultConfig,
  loadConfig,
  mergeConfig,
  resolveConfigPaths,
  validateConfig,
  validateHostedConfig,
} from "../../src/daemon/config.js";

describe("defaultConfig", () => {
  it("returns a full config object with sensible defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.wiki_root).toBe("./wiki-store");
    expect(cfg.models.ingest).toBe("claude-haiku-4-5");
    expect(cfg.models.query).toBe("claude-sonnet-4-5");
    expect(cfg.server.port).toBe(8787);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.auth_token).toBeNull();
    expect(cfg.server.rate_limit_rpm).toBe(60);
    expect(cfg.cost.max_daily_usd).toBe(10.0);
    expect(cfg.cost.max_per_ingest_usd).toBe(2.0);
    expect(cfg.compounding.enabled).toBe(true);
    expect(cfg.provenance.enabled).toBe(true);
    expect(cfg.multi_user.enabled).toBe(false);
  });

  it("returns a fresh copy each time (no shared references)", () => {
    const a = defaultConfig();
    const b = defaultConfig();
    a.cost.max_daily_usd = 999;
    expect(b.cost.max_daily_usd).toBe(10.0);
  });
});

describe("mergeConfig", () => {
  it("deep-merges a partial override without mutating base", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, {
      cost: { max_daily_usd: 5.0 } as never,
    });
    expect(merged.cost.max_daily_usd).toBe(5.0);
    // Other fields preserved
    expect(merged.cost.max_per_ingest_usd).toBe(base.cost.max_per_ingest_usd);
    // Base untouched
    expect(base.cost.max_daily_usd).toBe(10.0);
  });

  it("overrides top-level scalars", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, { wiki_root: "/custom" });
    expect(merged.wiki_root).toBe("/custom");
  });

  it("merges models field by field", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, {
      models: { ingest: "claude-opus-4-6" } as never,
    });
    expect(merged.models.ingest).toBe("claude-opus-4-6");
    expect(merged.models.query).toBe(base.models.query);
  });

  it("merges server config field by field", () => {
    const base = defaultConfig();
    const merged = mergeConfig(base, {
      server: { port: 9999 } as never,
    });
    expect(merged.server.port).toBe(9999);
    expect(merged.server.host).toBe(base.server.host);
  });
});

describe("validateConfig", () => {
  it("passes a valid default config", () => {
    const cfg = defaultConfig();
    expect(() => validateConfig(cfg)).not.toThrow();
  });

  it("rejects an invalid type (string where number expected)", () => {
    const cfg = defaultConfig();
    (cfg.server as Record<string, unknown>).port = "not-a-number";
    expect(() => validateConfig(cfg)).toThrow(/server\.port/);
  });

  it("rejects a negative number where positive is required", () => {
    const cfg = defaultConfig();
    cfg.cost.max_daily_usd = -5;
    expect(() => validateConfig(cfg)).toThrow(/cost\.max_daily_usd/);
  });

  it("rejects a port out of range", () => {
    const cfg = defaultConfig();
    cfg.server.port = 99999;
    expect(() => validateConfig(cfg)).toThrow(/server\.port/);
  });

  it("rejects an invalid execution mode", () => {
    const cfg = defaultConfig();
    (cfg.execution as Record<string, unknown>).mode = "invalid";
    expect(() => validateConfig(cfg)).toThrow(/execution\.mode/);
  });

  it("preserves llm block through validation (regression: Zod stripped it pre-fix)", () => {
    const cfg = defaultConfig();
    const validated = validateConfig(cfg);
    expect(validated.llm).toBeDefined();
    expect(validated.llm.provider).toBe("anthropic");
    expect(validated.llm.model).toBe("claude-sonnet-4-5");
  });

  it("rejects an invalid llm provider", () => {
    const cfg = defaultConfig();
    (cfg.llm as Record<string, unknown>).provider = "bogus-provider";
    expect(() => validateConfig(cfg)).toThrow(/llm\.provider/);
  });

  it("rejects an invalid log level", () => {
    const cfg = defaultConfig();
    (cfg.daemon as Record<string, unknown>).log_level = "verbose";
    expect(() => validateConfig(cfg)).toThrow(/daemon\.log_level/);
  });

  it("error message includes the field name", () => {
    const cfg = defaultConfig();
    cfg.watcher.debounce_initial_ms = -100;
    try {
      validateConfig(cfg);
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("watcher.debounce_initial_ms");
    }
  });

  it("rejects a non-boolean trust_proxy", () => {
    const cfg = defaultConfig();
    (cfg.server as Record<string, unknown>).trust_proxy = "yes";
    expect(() => validateConfig(cfg)).toThrow(/server\.trust_proxy/);
  });

  it("rejects a non-boolean staging", () => {
    const cfg = defaultConfig();
    (cfg.ingestion as Record<string, unknown>).staging = "always";
    expect(() => validateConfig(cfg)).toThrow(/ingestion\.staging/);
  });

  it("accepts valid trust_proxy and staging values", () => {
    const cfg = defaultConfig();
    cfg.server.trust_proxy = true;
    cfg.ingestion.staging = false;
    expect(() => validateConfig(cfg)).not.toThrow();
  });
});

describe("resolveConfigPaths", () => {
  it("resolves all path fields to absolute paths", () => {
    const cfg = defaultConfig();
    const resolved = resolveConfigPaths(cfg, "/tmp/base");
    expect(isAbsolute(resolved.wiki_root)).toBe(true);
    expect(isAbsolute(resolved.raw_path)).toBe(true);
    expect(isAbsolute(resolved.cost.track_file)).toBe(true);
    expect(isAbsolute(resolved.daemon.pid_file)).toBe(true);
    expect(isAbsolute(resolved.daemon.lock_file)).toBe(true);
    expect(isAbsolute(resolved.daemon.log_file)).toBe(true);
    expect(isAbsolute(resolved.provenance.chain_file)).toBe(true);
    expect(isAbsolute(resolved.multi_user.workspaces_dir)).toBe(true);
  });

  it("does not mutate the input", () => {
    const cfg = defaultConfig();
    const before = cfg.wiki_root;
    resolveConfigPaths(cfg, "/tmp/base");
    expect(cfg.wiki_root).toBe(before);
  });

  it("resolves chain_file relative to wiki_root", () => {
    const cfg = defaultConfig();
    cfg.wiki_root = "/abs/wiki";
    cfg.provenance.chain_file = "provenance-chain.jsonl";
    const resolved = resolveConfigPaths(cfg, "/tmp/base");
    expect(resolved.provenance.chain_file).toBe("/abs/wiki/provenance-chain.jsonl");
  });
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-cfg-"));
}

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const emptyDir = tmp();
    const result = await loadConfig(emptyDir);
    const defaults = defaultConfig();
    expect(result.path).toBeNull();
    expect(result.config.wiki_root).toBe(defaults.wiki_root);
    expect(result.config.server.port).toBe(defaults.server.port);
    expect(result.config.cost.max_daily_usd).toBe(defaults.cost.max_daily_usd);
    expect(result.config.models.ingest).toBe(defaults.models.ingest);
  });

  it("merges file values over defaults", async () => {
    const dir = tmp();
    writeFileSync(join(dir, "wotw.config.yaml"), "server:\n  port: 3333\n");
    const result = await loadConfig(dir);
    expect(result.path).not.toBeNull();
    expect(result.config.server.port).toBe(3333);
    // Other defaults preserved
    const defaults = defaultConfig();
    expect(result.config.server.host).toBe(defaults.server.host);
    expect(result.config.cost.max_daily_usd).toBe(defaults.cost.max_daily_usd);
  });
});

// ---------------------------------------------------------------------------
// Phase 24 — Pass 006 — Hosted-mode env overrides + validation
// ---------------------------------------------------------------------------

describe("applyEnvOverrides", () => {
  // Each test snapshots and restores the env vars it touches so the suite
  // remains deterministic regardless of run order.
  // Review item 66: env vars touched by applyEnvOverrides that weren't
  // in the snapshot/restore list — tests touching these would leak
  // state between runs.
  const ENV_KEYS = [
    "WOTW_HOSTED",
    "TENANT_ID",
    "WIKI_ROOT",
    "WOTW_PLAN",
    "WOTW_TIMEZONE",
    "WOTW_PORT",
    "WOTW_HOST",
    "WOTW_LOG_LEVEL",
    "WOTW_RUNTIME_MODE",
    "ADMIN_SERVICE_KEY",
    "WOTW_MCP_BEARER",
    "WOTW_INTERNAL_ADMIN_KEY",
    "WOTW_CLOUD_SINK_SECRET",
    "WOTW_LLM_PROVIDER",
    "WOTW_LLM_MODEL",
    "WOTW_OLLAMA_URL",
    "WOTW_LOG_FILE",
    "WOTW_API_BASE_URL",
  ] as const;

  function withEnv<T>(
    overrides: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>,
    fn: () => T,
  ): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    try {
      for (const k of ENV_KEYS) {
        const v = overrides[k];
        if (v === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = v;
        }
      }
      return fn();
    } finally {
      for (const k of ENV_KEYS) {
        const orig = saved[k];
        if (orig === undefined) delete process.env[k];
        else process.env[k] = orig;
      }
    }
  }

  it("is a no-op when no env vars are set", () => {
    withEnv({}, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out).toEqual(defaultConfig());
    });
  });

  it("WOTW_HOSTED=true flips hosted.enabled", () => {
    withEnv({ WOTW_HOSTED: "true" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.hosted.enabled).toBe(true);
    });
  });

  it("TENANT_ID overrides hosted.tenant_id", () => {
    withEnv({ TENANT_ID: "11111111-2222-3333-4444-555555555555" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.hosted.tenant_id).toBe("11111111-2222-3333-4444-555555555555");
    });
  });

  it("WIKI_ROOT overrides wiki_root", () => {
    withEnv({ WIKI_ROOT: "/data/myorg" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.wiki_root).toBe("/data/myorg");
    });
  });

  it("WOTW_PORT and WOTW_HOST override server bindings", () => {
    withEnv({ WOTW_PORT: "3000", WOTW_HOST: "0.0.0.0" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.server.port).toBe(3000);
      expect(out.server.host).toBe("0.0.0.0");
    });
  });

  it("ADMIN_SERVICE_KEY sets server.auth_token", () => {
    withEnv({ ADMIN_SERVICE_KEY: "tok_xxx" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.server.auth_token).toBe("tok_xxx");
    });
  });

  it("invalid WOTW_PORT is ignored (out-of-range)", () => {
    withEnv({ WOTW_PORT: "99999" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.server.port).toBe(defaultConfig().server.port);
    });
  });

  it("invalid WOTW_PLAN is ignored", () => {
    withEnv({ WOTW_PLAN: "notathing" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.hosted.plan).toBe(defaultConfig().hosted.plan);
    });
  });

  it("invalid WOTW_LOG_LEVEL is ignored", () => {
    withEnv({ WOTW_LOG_LEVEL: "screaming" }, () => {
      const out = applyEnvOverrides(defaultConfig());
      expect(out.daemon.log_level).toBe(defaultConfig().daemon.log_level);
    });
  });

  it("does not mutate the input config", () => {
    withEnv({ TENANT_ID: "11111111-2222-3333-4444-555555555555" }, () => {
      const input = defaultConfig();
      applyEnvOverrides(input);
      expect(input.hosted.tenant_id).toBeNull();
    });
  });
});

describe("validateHostedConfig", () => {
  it("is a no-op when hosted.enabled is false", () => {
    const cfg = defaultConfig();
    expect(cfg.hosted.enabled).toBe(false);
    expect(() => validateHostedConfig(cfg)).not.toThrow();
  });

  it("throws when hosted.enabled is true but tenant_id is missing", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = null;
    expect(() => validateHostedConfig(cfg)).toThrowError(/TENANT_ID.*hosted\.tenant_id is unset/);
  });

  it("throws when tenant_id is present but not a UUID", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = "not-a-uuid";
    cfg.wiki_root = "/data/x";
    expect(() => validateHostedConfig(cfg)).toThrowError(/not a valid UUID/);
  });

  it("accepts a valid UUID with mixed case", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = "AAAAAAAA-bbbb-CCCC-dddd-EEEEEEEEEEEE";
    cfg.wiki_root = "/data/x";
    expect(() => validateHostedConfig(cfg)).not.toThrow();
  });

  it("throws when wiki_root is empty in hosted mode", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = "11111111-2222-3333-4444-555555555555";
    cfg.wiki_root = "";
    expect(() => validateHostedConfig(cfg)).toThrowError(/wiki_root.*WIKI_ROOT is unset/);
  });

  it("review item 60: rejects relative wiki_root in hosted mode", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = "11111111-2222-3333-4444-555555555555";
    cfg.wiki_root = "./relative-path";
    expect(() => validateHostedConfig(cfg)).toThrowError(/not absolute/);
  });

  it("review item 60: accepts absolute wiki_root in hosted mode", () => {
    const cfg = defaultConfig();
    cfg.hosted.enabled = true;
    cfg.hosted.tenant_id = "11111111-2222-3333-4444-555555555555";
    cfg.wiki_root = "/data/tenant-uuid";
    expect(() => validateHostedConfig(cfg)).not.toThrow();
  });
});

describe("hosted-mode default overrides (review item 65)", () => {
  // Validation-gap-instance #12 (2026-05-12) introduced 3 hosted-mode
  // overrides in applyEnvOverrides; the regression had no guard. These
  // tests pin the inverted-default contract so a future refactor can't
  // re-introduce the bug.
  const SAVED_HOSTED = process.env.WOTW_HOSTED;
  afterAll(() => {
    if (SAVED_HOSTED === undefined) delete process.env.WOTW_HOSTED;
    else process.env.WOTW_HOSTED = SAVED_HOSTED;
  });

  it("hosted mode inverts ingestion.staging from true → false", async () => {
    process.env.WOTW_HOSTED = "true";
    process.env.TENANT_ID = "11111111-2222-3333-4444-555555555555";
    process.env.WIKI_ROOT = "/data/test";
    try {
      const cfg = applyEnvOverrides(defaultConfig());
      expect(cfg.hosted.enabled).toBe(true);
      expect(cfg.ingestion.staging).toBe(false);
    } finally {
      delete process.env.WOTW_HOSTED;
      delete process.env.TENANT_ID;
      delete process.env.WIKI_ROOT;
    }
  });

  it("hosted mode enables lint.schedule_enabled by default", async () => {
    process.env.WOTW_HOSTED = "true";
    process.env.TENANT_ID = "11111111-2222-3333-4444-555555555555";
    process.env.WIKI_ROOT = "/data/test";
    try {
      const cfg = applyEnvOverrides(defaultConfig());
      expect(cfg.lint.schedule_enabled).toBe(true);
    } finally {
      delete process.env.WOTW_HOSTED;
      delete process.env.TENANT_ID;
      delete process.env.WIKI_ROOT;
    }
  });

  it("WOTW_HOSTED truthy alternates accept 1 / yes / on (review item 61)", async () => {
    for (const v of ["1", "yes", "on", "True", "TRUE"]) {
      process.env.WOTW_HOSTED = v;
      try {
        const cfg = applyEnvOverrides(defaultConfig());
        expect(cfg.hosted.enabled).toBe(true);
      } finally {
        delete process.env.WOTW_HOSTED;
      }
    }
  });
});
