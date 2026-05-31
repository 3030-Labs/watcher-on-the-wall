/**
 * Tests for validateHostedRedactionSink — the FEATURE-PASS-011
 * hosted-mode invariant for the daemon→cloud redaction-emit wire.
 *
 * Hosted mode + missing WOTW_CLOUD_SINK_SECRET MUST throw with a clear
 * message. Local/offline mode (hosted.enabled false) is unaffected.
 */
import { describe, expect, it } from "vitest";
import { defaultConfig, validateHostedRedactionSink } from "../../src/daemon/config.js";
import type { WotwConfig } from "../../src/utils/types.js";

function hostedConfig(): WotwConfig {
  const c = defaultConfig();
  c.hosted.enabled = true;
  c.hosted.tenant_id = "00000000-0000-4000-8000-000000000099";
  c.wiki_root = "/data/wiki";
  return c;
}

describe("validateHostedRedactionSink", () => {
  it("is a no-op when hosted.enabled is false (regardless of env)", () => {
    const c = defaultConfig();
    expect(() => validateHostedRedactionSink(c, {} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() =>
      validateHostedRedactionSink(c, {
        WOTW_CLOUD_SINK_SECRET: "x",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("throws when hosted.enabled is true AND WOTW_CLOUD_SINK_SECRET is unset", () => {
    expect(() => validateHostedRedactionSink(hostedConfig(), {} as NodeJS.ProcessEnv)).toThrowError(
      /WOTW_CLOUD_SINK_SECRET is unset/,
    );
  });

  it("throws when hosted.enabled is true AND WOTW_CLOUD_SINK_SECRET is empty string", () => {
    expect(() =>
      validateHostedRedactionSink(hostedConfig(), {
        WOTW_CLOUD_SINK_SECRET: "",
      } as NodeJS.ProcessEnv),
    ).toThrowError(/WOTW_CLOUD_SINK_SECRET is unset/);
  });

  it("succeeds when hosted.enabled is true AND WOTW_CLOUD_SINK_SECRET is non-empty", () => {
    expect(() =>
      validateHostedRedactionSink(hostedConfig(), {
        WOTW_CLOUD_SINK_SECRET: "live-secret",
      } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });
});
