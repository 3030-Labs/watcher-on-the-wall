/**
 * Unit tests for the `wotw stale` command logic.
 * Tests the health-based staleness scoring, duration parsing,
 * score thresholds, and Dataview dashboard generation.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateDashboard,
  parseDuration,
  scoreThresholdForDuration,
} from "../../src/cli/commands/stale.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-stale-"));
}

describe("parseDuration", () => {
  it("parses days", () => {
    expect(parseDuration("14d")).toBe(14);
    expect(parseDuration("30d")).toBe(30);
    expect(parseDuration("1d")).toBe(1);
  });

  it("parses weeks", () => {
    expect(parseDuration("2w")).toBe(14);
    expect(parseDuration("4w")).toBe(28);
  });

  it("throws on invalid input", () => {
    expect(() => parseDuration("abc")).toThrow("Invalid duration");
    expect(() => parseDuration("14m")).toThrow("Invalid duration");
  });
});

describe("scoreThresholdForDuration", () => {
  const thresholds = [7, 30, 90, 180, 365];
  const scores = [100, 80, 60, 40, 20, 0];

  it("7d threshold returns 100", () => {
    expect(scoreThresholdForDuration(7, thresholds, scores)).toBe(100);
  });

  it("14d falls in 7-30 bucket, returns 80", () => {
    expect(scoreThresholdForDuration(14, thresholds, scores)).toBe(80);
  });

  it("30d exactly returns 80", () => {
    expect(scoreThresholdForDuration(30, thresholds, scores)).toBe(80);
  });

  it("90d exactly returns 60", () => {
    expect(scoreThresholdForDuration(90, thresholds, scores)).toBe(60);
  });

  it("beyond 365d returns last score (0)", () => {
    expect(scoreThresholdForDuration(400, thresholds, scores)).toBe(0);
  });
});

describe("Dataview dashboard", () => {
  it("dashboard skipped when Dataview not installed", () => {
    const root = tmpDir();
    mkdirSync(join(root, "wiki"), { recursive: true });
    generateDashboard(root);
    const dashboardPath = join(root, "wiki", "Stale Dashboard.md");
    expect(existsSync(dashboardPath)).toBe(false);
  });

  it("dashboard created when Dataview is present", () => {
    const root = tmpDir();
    mkdirSync(join(root, "wiki"), { recursive: true });
    mkdirSync(join(root, ".obsidian", "plugins", "dataview"), { recursive: true });

    generateDashboard(root);

    const dashboardPath = join(root, "wiki", "Stale Dashboard.md");
    expect(existsSync(dashboardPath)).toBe(true);
    const content = readFileSync(dashboardPath, "utf8");
    expect(content).toContain("dataview");
    expect(content).toContain("TABLE last_confirmed");
    expect(content).toContain("dur(30 days)");
  });

  it("dashboard not overwritten if already exists", () => {
    const root = tmpDir();
    mkdirSync(join(root, "wiki"), { recursive: true });
    mkdirSync(join(root, ".obsidian", "plugins", "dataview"), { recursive: true });

    const dashboardPath = join(root, "wiki", "Stale Dashboard.md");
    writeFileSync(dashboardPath, "USER_CUSTOM_CONTENT");

    generateDashboard(root);

    expect(readFileSync(dashboardPath, "utf8")).toBe("USER_CUSTOM_CONTENT");
  });
});
