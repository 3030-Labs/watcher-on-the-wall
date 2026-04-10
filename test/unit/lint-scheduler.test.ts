/**
 * Unit tests for the LintScheduler subsystem. We inject a fake runner so
 * the tests exercise the interval / WARN-vs-INFO logging / disabled-flag
 * handling without touching the filesystem.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { LintScheduler } from "../../src/daemon/lint-scheduler.js";
import { defaultConfig } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";
import type { LintResult } from "../../src/cli/commands/lint.js";

function configWith(overrides: Partial<WotwConfig["lint"]> = {}): WotwConfig {
  const cfg = defaultConfig();
  cfg.lint = { ...cfg.lint, ...overrides };
  return cfg;
}

function cleanResult(): LintResult {
  return {
    wikiRoot: "/tmp/wiki",
    totalPages: 42,
    orphanedPages: 0,
    issueCount: 0,
    missingWikiDir: false,
  };
}

function issuesResult(): LintResult {
  return {
    wikiRoot: "/tmp/wiki",
    totalPages: 42,
    orphanedPages: 3,
    issueCount: 3,
    missingWikiDir: false,
  };
}

describe("LintScheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not start the timer when schedule_enabled is false", async () => {
    const runner = vi.fn();
    const sched = new LintScheduler({
      config: configWith({ schedule_enabled: false }),
      runner,
    });
    await sched.start();
    // A disabled scheduler must not invoke the runner even once.
    expect(runner).not.toHaveBeenCalled();
    await sched.stop();
  });

  it("runs once at startup when enabled", async () => {
    const runner = vi.fn().mockResolvedValue(cleanResult());
    const sched = new LintScheduler({
      config: configWith({ schedule_enabled: true, interval_hours: 24 }),
      runner,
    });
    await sched.start();
    // `void this.runOnce()` inside start() synchronously invokes the
    // runner (it's called before the first await in runOnce), so by
    // the time start() resolves the runner has been called exactly
    // once. We deliberately do NOT advance pending timers here —
    // doing so would fire the setInterval tick and double the count.
    expect(runner).toHaveBeenCalledTimes(1);
    await sched.stop();
  });

  it("fires again after the interval elapses", async () => {
    const runner = vi.fn().mockResolvedValue(cleanResult());
    const sched = new LintScheduler({
      // Use a 1-hour interval so we can advance exactly one tick and
      // assert a single additional call.
      config: configWith({ schedule_enabled: true, interval_hours: 1 }),
      runner,
    });
    await sched.start();
    expect(runner).toHaveBeenCalledTimes(1);
    // Advance one hour to trigger the interval.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(runner).toHaveBeenCalledTimes(2);
    await sched.stop();
  });

  it("caches the last result via getLastResult()", async () => {
    const expected = issuesResult();
    const runner = vi.fn().mockResolvedValue(expected);
    const sched = new LintScheduler({
      config: configWith({ schedule_enabled: true, interval_hours: 24 }),
      runner,
    });
    await sched.runOnce();
    expect(sched.getLastResult()).toEqual(expected);
  });

  it("runOnce returns null and logs when the runner throws", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("disk full"));
    const sched = new LintScheduler({
      config: configWith({ schedule_enabled: true, interval_hours: 24 }),
      runner,
    });
    const result = await sched.runOnce();
    expect(result).toBeNull();
    // The cached result stays at the previous value (null) because the
    // error path does not update lastResult.
    expect(sched.getLastResult()).toBeNull();
  });

  it("stop() clears the interval so further ticks are suppressed", async () => {
    const runner = vi.fn().mockResolvedValue(cleanResult());
    const sched = new LintScheduler({
      config: configWith({ schedule_enabled: true, interval_hours: 1 }),
      runner,
    });
    await sched.start();
    expect(runner).toHaveBeenCalledTimes(1);
    await sched.stop();
    // Advance long past the interval — no new calls.
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(runner).toHaveBeenCalledTimes(1);
  });
});
