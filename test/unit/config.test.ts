/**
 * Unit tests for daemon/config.ts: defaults, deep-merge, and path resolution.
 */
import { describe, expect, it } from "vitest";
import { isAbsolute } from "node:path";
import { defaultConfig, mergeConfig, resolveConfigPaths } from "../../src/daemon/config.js";

describe("defaultConfig", () => {
  it("returns a full config object with sensible defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.wiki_root).toBeDefined();
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
