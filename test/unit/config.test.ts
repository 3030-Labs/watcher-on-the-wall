/**
 * Unit tests for daemon/config.ts: defaults, deep-merge, path resolution,
 * and cosmiconfig-based loadConfig() composition.
 */
import { describe, expect, it } from "vitest";
import { isAbsolute, join } from "node:path";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  defaultConfig,
  loadConfig,
  mergeConfig,
  resolveConfigPaths,
  validateConfig,
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
