/**
 * Tests for quota enforcement modules: StorageAccountant, DailyImportCounter,
 * IngestBytesCounter, HealCooldown.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageAccountant } from "../../src/hosted/storage-accountant.js";
import { DailyImportCounter } from "../../src/hosted/daily-import-counter.js";
import { IngestBytesCounter } from "../../src/hosted/ingest-bytes-counter.js";
import { HealCooldown } from "../../src/hosted/heal-cooldown.js";

function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "wotw-quota-"));
  mkdirSync(join(dir, "raw"), { recursive: true });
  mkdirSync(join(dir, "wiki"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// StorageAccountant
// ---------------------------------------------------------------------------
describe("StorageAccountant", () => {
  it("allows writes under the limit", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "raw", "a.md"), "x".repeat(100));
    const sa = new StorageAccountant(root, 1024 * 1024); // 1 MB limit

    expect(await sa.wouldExceed(100)).toBe(false);
    await expect(sa.checkOrThrow(100)).resolves.toBeUndefined();
  });

  it("rejects writes that would exceed the limit with clear message", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "raw", "big.bin"), "x".repeat(900_000));
    const sa = new StorageAccountant(root, 1_000_000); // 1 MB

    expect(await sa.wouldExceed(200_000)).toBe(true);
    await expect(sa.checkOrThrow(200_000)).rejects.toThrow(/Storage limit reached/);
    await expect(sa.checkOrThrow(200_000)).rejects.toThrow(/Free up space or upgrade/);
  });

  it("counts only raw + wiki content, not daemon state files", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, ".wotw"), { recursive: true });
    writeFileSync(join(root, ".wotw", "daemon.pid"), "12345");
    writeFileSync(join(root, ".wotw", "cost.jsonl"), "x".repeat(10_000));
    writeFileSync(join(root, "raw", "a.md"), "x".repeat(100));

    const sa = new StorageAccountant(root, 1_000_000);
    const usage = await sa.currentUsageBytes();
    // Should only count raw/a.md (100 bytes), not .wotw/ files
    expect(usage).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// DailyImportCounter
// ---------------------------------------------------------------------------
describe("DailyImportCounter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00.000-04:00")); // 2pm ET
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows imports within daily limit", () => {
    const counter = new DailyImportCounter({
      limit: 50,
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    counter.record(30);
    expect(counter.wouldExceed(10)).toBe(false);
    expect(counter.remaining()).toBe(20); // 50 - 30 = 20
  });

  it("rejects imports that exceed daily limit", () => {
    const counter = new DailyImportCounter({
      limit: 5,
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    counter.record(5);
    expect(() => counter.checkOrThrow(1)).toThrow(/Daily import limit reached/);
    expect(() => counter.checkOrThrow(1)).toThrow(/5 of 5 files today/);
  });

  it("resets at midnight in user's timezone", () => {
    const counter = new DailyImportCounter({
      limit: 5,
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    counter.record(5);
    expect(counter.wouldExceed(1)).toBe(true);

    // Advance past midnight ET (10 hours forward from 2pm)
    vi.advanceTimersByTime(10 * 60 * 60 * 1000);

    // Counter should have reset
    expect(counter.wouldExceed(1)).toBe(false);
    expect(counter.remaining()).toBe(5);
  });

  it("applies 3x burst multiplier during first 48 hours", () => {
    const counter = new DailyImportCounter({
      limit: 50,
      timezone: "America/New_York",
      createdAt: new Date(Date.now() - 1 * 60 * 60 * 1000), // 1 hour ago
      burstMultiplier: 3,
      burstHours: 48,
    });
    // Burst limit should be 150
    expect(counter.effectiveLimit()).toBe(150);
    counter.record(100);
    expect(counter.wouldExceed(40)).toBe(false);
    expect(counter.wouldExceed(51)).toBe(true);
  });

  it("reverts to normal limit after 48 hours", () => {
    const counter = new DailyImportCounter({
      limit: 50,
      timezone: "America/New_York",
      createdAt: new Date(Date.now() - 49 * 60 * 60 * 1000), // 49 hours ago
      burstMultiplier: 3,
      burstHours: 48,
    });
    expect(counter.effectiveLimit()).toBe(50);
  });

  it("counts only successful ingests, not attempts", () => {
    const counter = new DailyImportCounter({
      limit: 5,
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    // Only record() counts — checking without recording doesn't consume quota
    counter.checkOrThrow(3);
    counter.checkOrThrow(3);
    counter.checkOrThrow(3);
    // Still at 0 because we only checked, never recorded
    expect(counter.remaining()).toBe(5);
    counter.record(3);
    expect(counter.remaining()).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// IngestBytesCounter
// ---------------------------------------------------------------------------
describe("IngestBytesCounter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00.000-04:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows bytes within daily limit", () => {
    const counter = new IngestBytesCounter({
      limit: 1024 ** 3, // 1 GB
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    counter.record(500 * 1024 ** 2); // 500 MB
    expect(counter.wouldExceed(400 * 1024 ** 2)).toBe(false);
  });

  it("rejects bytes that would exceed daily limit", () => {
    const counter = new IngestBytesCounter({
      limit: 1024 ** 2, // 1 MB
      timezone: "America/New_York",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      burstMultiplier: 3,
      burstHours: 48,
    });
    counter.record(1024 ** 2); // 1 MB
    expect(() => counter.checkOrThrow(1)).toThrow(/Daily ingest bytes limit reached/);
  });
});

// ---------------------------------------------------------------------------
// HealCooldown
// ---------------------------------------------------------------------------
describe("HealCooldown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-15T14:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows heal after cooldown period", () => {
    const cd = new HealCooldown(900); // 15 min
    cd.recordHeal();
    vi.advanceTimersByTime(901_000); // 15 min + 1 sec
    expect(cd.canHeal()).toBe(true);
    expect(() => cd.checkOrThrow()).not.toThrow();
  });

  it("rejects heal during cooldown with wait time message", () => {
    const cd = new HealCooldown(900); // 15 min
    cd.recordHeal();
    vi.advanceTimersByTime(60_000); // 1 min later
    expect(cd.canHeal()).toBe(false);
    expect(() => cd.checkOrThrow()).toThrow(/Heal cooldown active/);
    expect(() => cd.checkOrThrow()).toThrow(/14 minutes/);
  });

  it("allows first heal without prior record", () => {
    const cd = new HealCooldown(900);
    expect(cd.canHeal()).toBe(true);
    expect(() => cd.checkOrThrow()).not.toThrow();
  });
});
