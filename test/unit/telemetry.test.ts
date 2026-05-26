/**
 * Tests for the opt-in BYO-DSN telemetry pipeline (PASS-023 item 17).
 *
 * Privacy invariants under test:
 *  1. Default is DISABLED — NoopSink returned when WOTW_TELEMETRY_DSN unset.
 *  2. SentrySink is returned ONLY when WOTW_TELEMETRY_DSN is non-empty.
 *  3. No 3030 Labs DSN is hardcoded.
 *  4. Validator rejects events with disallowed fields (PII leakage gate).
 *  5. Categorizer maps every ActionableErrorCode to a stable category.
 *  6. recordInitFailure swallows sink errors (telemetry must not break flow).
 */
import { describe, expect, it } from "vitest";
import {
  configParseError,
  daemonAlreadyRunningError,
  initTargetNotEmptyError,
  invalidApiKeyError,
  missingVaultPathError,
  nativeBindingLoadError,
  portInUseError,
  rateLimitedError,
  vaultFileLockedError,
  wikiDirPermissionError,
} from "../../src/utils/actionable-error.js";
import {
  MemorySink,
  NoopSink,
  SentrySink,
  categorizeInitFailure,
  getTelemetrySink,
  recordInitFailure,
  validateEvent,
} from "../../src/telemetry/index.js";
import type {
  TelemetryFailureCategory,
  TelemetryFailureEvent,
  TelemetrySink,
} from "../../src/telemetry/index.js";

describe("telemetry default — DISABLED", () => {
  it("getTelemetrySink returns NoopSink when WOTW_TELEMETRY_DSN is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    const sink = getTelemetrySink(env);
    expect(sink).toBeInstanceOf(NoopSink);
  });

  it("getTelemetrySink returns NoopSink when WOTW_TELEMETRY_DSN is empty string", () => {
    const env: NodeJS.ProcessEnv = { WOTW_TELEMETRY_DSN: "" };
    expect(getTelemetrySink(env)).toBeInstanceOf(NoopSink);
  });

  it("getTelemetrySink returns NoopSink when WOTW_TELEMETRY_DSN is whitespace", () => {
    const env: NodeJS.ProcessEnv = { WOTW_TELEMETRY_DSN: "   " };
    expect(getTelemetrySink(env)).toBeInstanceOf(NoopSink);
  });
});

describe("telemetry opt-in — SentrySink when DSN provided", () => {
  it("returns SentrySink when WOTW_TELEMETRY_DSN is set", () => {
    const env: NodeJS.ProcessEnv = {
      WOTW_TELEMETRY_DSN: "https://abc@o123.ingest.sentry.io/456",
    };
    const sink = getTelemetrySink(env);
    expect(sink).toBeInstanceOf(SentrySink);
  });

  it("trims surrounding whitespace from DSN", () => {
    const env: NodeJS.ProcessEnv = {
      WOTW_TELEMETRY_DSN: "  https://abc@sentry.io/1  ",
    };
    const sink = getTelemetrySink(env);
    expect(sink).toBeInstanceOf(SentrySink);
  });
});

describe("no embedded DSN — 3030 Labs", () => {
  it("source code contains no Sentry DSN", async () => {
    const { readFileSync } = await import("node:fs");
    const sinkSrc = readFileSync(new URL("../../src/telemetry/sink.ts", import.meta.url), "utf8");
    expect(sinkSrc).not.toMatch(/sentry\.io\/\d+/);
    expect(sinkSrc).not.toMatch(/ingest\.sentry/);
    // Specifically no @sentry.io/PROJECT_ID-style literal
    expect(sinkSrc).not.toMatch(/@\w+\.ingest\.sentry\.io/);
  });
});

describe("validateEvent — PII leakage gate", () => {
  function validEvent(): TelemetryFailureEvent {
    return {
      category: "init/missing-vault-path",
      daemonVersion: "0.8.4",
      platform: "linux",
      arch: "x64",
      nodeVersion: "v22.16.0",
    };
  }

  it("accepts the canonical shape", () => {
    expect(validateEvent(validEvent())).toBeNull();
  });

  it("accepts the canonical shape with stage", () => {
    expect(validateEvent({ ...validEvent(), stage: "scaffold-mkdir" })).toBeNull();
  });

  it("rejects disallowed fields", () => {
    const bad = { ...validEvent(), apiKey: "sk-ant-leaked" };
    expect(validateEvent(bad)).toMatch(/disallowed field/);
  });

  it("rejects a vault path injected via stage", () => {
    // stage must be a stable enum-like string; non-string values rejected
    const bad = { ...validEvent(), stage: { path: "/home/user/vault" } };
    expect(validateEvent(bad)).toMatch(/stage must be a string/);
  });

  it("rejects unknown category", () => {
    const bad = { ...validEvent(), category: "unknown-category" };
    expect(validateEvent(bad)).toMatch(/category not in allow-list/);
  });

  it("rejects null / non-object", () => {
    expect(validateEvent(null)).toMatch(/event must be an object/);
    expect(validateEvent("a string")).toMatch(/event must be an object/);
    expect(validateEvent(42)).toMatch(/event must be an object/);
  });

  it("rejects missing daemonVersion", () => {
    const obj: Record<string, unknown> = { ...validEvent() };
    delete obj.daemonVersion;
    expect(validateEvent(obj)).toMatch(/daemonVersion/);
  });

  it("rejects empty daemonVersion", () => {
    const obj = { ...validEvent(), daemonVersion: "" };
    expect(validateEvent(obj)).toMatch(/daemonVersion/);
  });
});

describe("MemorySink — validates on record", () => {
  it("records valid events", () => {
    const sink = new MemorySink();
    sink.recordInitFailure({
      category: "init/missing-vault-path",
      daemonVersion: "0.8.4",
      platform: "linux",
      arch: "x64",
      nodeVersion: "v22.16.0",
    });
    expect(sink.recorded()).toHaveLength(1);
  });

  it("throws on invalid events (validator first line of defense)", () => {
    const sink = new MemorySink();
    expect(() =>
      sink.recordInitFailure({
        category: "init/missing-vault-path",
        daemonVersion: "0.8.4",
        platform: "linux",
        arch: "x64",
        // @ts-expect-error — deliberate type violation to test runtime guard
        leakedField: "secret",
      }),
    ).toThrow(/disallowed field/);
  });

  it("clear() resets the buffer", () => {
    const sink = new MemorySink();
    sink.recordInitFailure({
      category: "init/missing-vault-path",
      daemonVersion: "0.8.4",
      platform: "linux",
      arch: "x64",
      nodeVersion: "v22.16.0",
    });
    sink.clear();
    expect(sink.recorded()).toHaveLength(0);
  });

  it("records a defensive copy (mutation doesn't leak)", () => {
    const sink = new MemorySink();
    const event: TelemetryFailureEvent = {
      category: "init/missing-vault-path",
      daemonVersion: "0.8.4",
      platform: "linux",
      arch: "x64",
      nodeVersion: "v22.16.0",
    };
    sink.recordInitFailure(event);
    // Caller-side mutation of original after-the-fact:
    (event as { category: string }).category = "init/unknown-failure";
    // Stored value preserved
    expect(sink.recorded()[0].category).toBe("init/missing-vault-path");
  });
});

describe("categorizeInitFailure", () => {
  const cases: {
    name: string;
    err: unknown;
    expected: TelemetryFailureCategory;
  }[] = [
    {
      name: "MISSING_VAULT_PATH",
      err: missingVaultPathError(),
      expected: "init/missing-vault-path",
    },
    {
      name: "INIT_TARGET_NOT_EMPTY",
      err: initTargetNotEmptyError("/p", ["x"]),
      expected: "init/target-not-empty",
    },
    {
      name: "CONFIG_PARSE_ERROR",
      err: configParseError("/p", new Error("x")),
      expected: "init/config-parse-error",
    },
    {
      name: "NATIVE_BINDING_LOAD_FAILURE",
      err: nativeBindingLoadError("better-sqlite3", new Error("x")),
      expected: "init/native-binding-load-failure",
    },
    {
      name: "WIKI_DIR_PERMISSION_DENIED",
      err: wikiDirPermissionError("/p", new Error("x")),
      expected: "init/wiki-dir-permission-denied",
    },
    {
      name: "PORT_IN_USE",
      err: portInUseError(4317),
      expected: "init/port-in-use",
    },
    {
      name: "DAEMON_ALREADY_RUNNING",
      err: daemonAlreadyRunningError("/p"),
      expected: "init/daemon-already-running",
    },
    {
      name: "INVALID_API_KEY",
      err: invalidApiKeyError("anthropic", "ANTHROPIC_API_KEY"),
      expected: "init/runtime-not-detected",
    },
    {
      name: "RATE_LIMITED",
      err: rateLimitedError("anthropic", 5),
      expected: "init/runtime-not-detected",
    },
    {
      name: "VAULT_FILE_LOCKED",
      err: vaultFileLockedError("/p", new Error("x")),
      expected: "init/scaffold-failed",
    },
  ];

  for (const { name, err, expected } of cases) {
    it(`maps ${name} → ${expected}`, () => {
      expect(categorizeInitFailure(err)).toBe(expected);
    });
  }

  it("maps plain Error → init/unknown-failure", () => {
    expect(categorizeInitFailure(new Error("anything"))).toBe("init/unknown-failure");
  });

  it("maps undefined → init/unknown-failure", () => {
    expect(categorizeInitFailure(undefined)).toBe("init/unknown-failure");
  });

  it("maps non-Error values → init/unknown-failure", () => {
    expect(categorizeInitFailure("a string")).toBe("init/unknown-failure");
    expect(categorizeInitFailure({})).toBe("init/unknown-failure");
  });
});

describe("recordInitFailure — orchestration", () => {
  it("emits a validated event to the sink", () => {
    const sink = new MemorySink();
    recordInitFailure(sink, missingVaultPathError());
    const recorded = sink.recorded();
    expect(recorded).toHaveLength(1);
    expect(recorded[0].category).toBe("init/missing-vault-path");
    expect(recorded[0].daemonVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(recorded[0].platform).toBe(process.platform);
    expect(recorded[0].arch).toBe(process.arch);
    expect(recorded[0].nodeVersion).toBe(process.version);
  });

  it("includes optional stage when provided", () => {
    const sink = new MemorySink();
    recordInitFailure(sink, missingVaultPathError(), "vault-resolution");
    expect(sink.recorded()[0].stage).toBe("vault-resolution");
  });

  it("omits stage when undefined", () => {
    const sink = new MemorySink();
    recordInitFailure(sink, missingVaultPathError());
    expect(sink.recorded()[0].stage).toBeUndefined();
  });

  it("never throws when the sink throws (best-effort guarantee)", () => {
    class BrokenSink implements TelemetrySink {
      recordInitFailure(): void {
        throw new Error("sink is broken");
      }
    }
    const sink = new BrokenSink();
    expect(() => recordInitFailure(sink, missingVaultPathError())).not.toThrow();
  });

  it("returns the event that was (attempted to be) recorded", () => {
    const sink = new MemorySink();
    const event = recordInitFailure(sink, missingVaultPathError());
    expect(event.category).toBe("init/missing-vault-path");
  });
});

describe("NoopSink", () => {
  it("never throws regardless of input", () => {
    const sink = new NoopSink();
    expect(() =>
      sink.recordInitFailure({
        category: "init/missing-vault-path",
        daemonVersion: "0.8.4",
        platform: "linux",
        arch: "x64",
        nodeVersion: "v22.16.0",
      }),
    ).not.toThrow();
  });

  it("is the default sink in disabled mode", () => {
    const sink = getTelemetrySink({});
    expect(sink).toBeInstanceOf(NoopSink);
    // No observable side effects
    sink.recordInitFailure({
      category: "init/missing-vault-path",
      daemonVersion: "0.8.4",
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
    });
  });
});
