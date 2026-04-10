/**
 * Unit tests for `wotw logs`. We drive {@link runLogs} directly (not
 * via commander) and redirect stdout to capture the emitted lines.
 * Follow mode isn't exercised here because it installs process-level
 * signal handlers; a narrower "print the last N lines" test covers
 * the primary code path.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLogs } from "../../src/cli/commands/logs.js";
import * as config from "../../src/daemon/config.js";
import { defaultConfig } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

function captureStdout(): { get(): string; restore(): void } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((data: string | Uint8Array): boolean => {
    chunks.push(typeof data === "string" ? data : Buffer.from(data).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  return {
    get: () => chunks.join(""),
    restore: () => {
      process.stdout.write = orig;
    },
  };
}

function writeLogFile(lines: number): string {
  const dir = mkdtempSync(join(tmpdir(), "wotw-logs-"));
  const file = join(dir, "daemon.log");
  const body: string[] = [];
  for (let i = 1; i <= lines; i++) {
    body.push(`line-${i.toString().padStart(4, "0")}`);
  }
  writeFileSync(file, `${body.join("\n")}\n`, "utf8");
  return file;
}

function mockLoadConfig(logFile: string): void {
  vi.spyOn(config, "loadConfig").mockResolvedValue({
    config: ((): WotwConfig => {
      const c = defaultConfig();
      c.daemon.log_file = logFile;
      return c;
    })(),
    path: null,
  });
  vi.spyOn(config, "resolveConfigPaths").mockImplementation((c) => c);
}

describe("wotw logs", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints the default 20 trailing lines", async () => {
    const file = writeLogFile(100);
    mockLoadConfig(file);
    const cap = captureStdout();
    try {
      await runLogs({});
    } finally {
      cap.restore();
    }
    const out = cap.get().split("\n").filter(Boolean);
    expect(out).toHaveLength(20);
    expect(out[0]).toBe("line-0081");
    expect(out[19]).toBe("line-0100");
  });

  it("respects an explicit --lines count", async () => {
    const file = writeLogFile(50);
    mockLoadConfig(file);
    const cap = captureStdout();
    try {
      await runLogs({ lines: "5" });
    } finally {
      cap.restore();
    }
    const out = cap.get().split("\n").filter(Boolean);
    expect(out).toHaveLength(5);
    expect(out[0]).toBe("line-0046");
    expect(out[4]).toBe("line-0050");
  });

  it("handles a log shorter than the requested tail", async () => {
    const file = writeLogFile(3);
    mockLoadConfig(file);
    const cap = captureStdout();
    try {
      await runLogs({ lines: "20" });
    } finally {
      cap.restore();
    }
    const out = cap.get().split("\n").filter(Boolean);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("line-0001");
  });

  it("warns cleanly when the log file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wotw-logs-"));
    mockLoadConfig(join(dir, "missing.log"));
    const cap = captureStdout();
    try {
      await runLogs({});
    } finally {
      cap.restore();
    }
    const out = cap.get();
    expect(out).toContain("no log file at");
  });

  it("exits cleanly on an invalid --lines value", async () => {
    const file = writeLogFile(5);
    mockLoadConfig(file);
    const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    try {
      await expect(runLogs({ lines: "abc" })).rejects.toThrow("exit:1");
    } finally {
      exit.mockRestore();
    }
  });
});
