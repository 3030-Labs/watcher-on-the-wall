/**
 * Tests for the prompt-builder → RedactionEmitStore hook
 * (FEATURE-PASS-011).
 *
 * Covers gate-required scenarios:
 *   - write-before-emit ordering: the SQLite row exists BEFORE any
 *     emission attempt (prompt-builder enqueues synchronously)
 *   - chain-write unaffected (regression): with-store and without-store
 *     produce byte-identical prompt.text, so the provenance chain's
 *     canonical payload + hash are unchanged
 *   - truncation_32kb event fires when input exceeds the 32KB cap
 *   - credential rules emit one row per fired rule with cloud_rule_id +
 *     byte_count
 *   - PII rules (credit-card, us-ssn) do NOT enqueue (stay daemon-local)
 */
import { describe, expect, it } from "vitest";
import { buildIngestionPrompt } from "../../../src/ingestion/prompt-builder.js";
import { RedactionEmitStore } from "../../../src/provenance/redaction-emit-store.js";
import type { WotwConfig } from "../../../src/utils/types.js";

const WORKSPACE_ID = "00000000-0000-4000-8000-000000000011";

function makeConfig(): WotwConfig {
  // Build a minimal config — only the fields buildIngestionPrompt reads.
  return {
    wiki_root: "/wiki",
    raw_path: "/wiki/raw",
  } as unknown as WotwConfig;
}

describe("prompt-builder × RedactionEmitStore — write-before-emit ordering", () => {
  it("enqueues a credential_pattern row when AWS access key is in input", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const token = "AKIA" + "A".repeat(16);
    const result = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/secret.md"],
      readFile: () => `before ${token} after`,
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    // (a) Row landed in SQLite during the buildIngestionPrompt call —
    //     this is the durability guarantee. No worker has run yet.
    const pending = store.listPending(10);
    expect(pending).toHaveLength(1);
    expect(pending[0].payload.rule_id).toBe("credential_pattern_01");
    expect(pending[0].payload.source_file_path).toBe("/raw/secret.md");
    expect(pending[0].payload.redaction_byte_count).toBe(20);
    expect(pending[0].workspace_id).toBe(WORKSPACE_ID);
    // (b) The excerpt itself was still sanitized.
    expect(result.excerpts[0].excerpt).toContain("[REDACTED:AWS_ACCESS_KEY]");
    expect(result.excerpts[0].excerpt).not.toContain(token);
    store.close();
  });

  it("emits one row per fired rule for multi-rule input", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const aws = "AKIA" + "A".repeat(16);
    const gh = "ghp_" + "A".repeat(36);
    await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/multi.md"],
      readFile: () => `aws=${aws} gh=${gh}`,
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    const ruleIds = store.listPending(10).map((r) => r.payload.rule_id);
    expect(ruleIds).toContain("credential_pattern_01"); // aws
    expect(ruleIds).toContain("credential_pattern_03"); // github
    store.close();
  });

  it("PII rules (credit-card, us-ssn) redact but do NOT enqueue", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const result = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/pii.md"],
      readFile: () => "card=4111111111111111 ssn=123-45-6789",
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    // Excerpt still redacts (daemon-local PII guard intact).
    expect(result.excerpts[0].excerpt).toContain("[REDACTED:PAN]");
    expect(result.excerpts[0].excerpt).toContain("[REDACTED:SSN]");
    // No rows enqueued — credit-card + us-ssn lack cloud_rule_id by design.
    expect(store.countByStatus().pending).toBe(0);
    store.close();
  });

  it("enqueues a truncation_32kb event when the 32KB cap fires", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const oversize = "x".repeat(40_000); // 40KB raw — exceeds 32KB cap
    await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/large.md"],
      readFile: () => oversize,
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    const pending = store.listPending(10);
    const trunc = pending.find((r) => r.payload.rule_id === "truncation_32kb");
    expect(trunc).toBeDefined();
    expect(trunc?.payload.source_file_path).toBe("/raw/large.md");
    // byte_count = bytes-dropped (40000 - 32768 = 7232).
    expect(trunc?.payload.redaction_byte_count).toBe(40_000 - 32 * 1024);
    store.close();
  });

  it("offline mode (no store) — redaction still applies, no enqueue, no crash", async () => {
    const token = "AKIA" + "A".repeat(16);
    const result = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/x.md"],
      readFile: () => `key=${token}`,
      // redactionEmitStore + workspaceId intentionally omitted
      claudeMdOverride: "SYS",
    });
    expect(result.excerpts[0].excerpt).toContain("[REDACTED:AWS_ACCESS_KEY]");
  });

  it("workspaceId omitted skips enqueue even if store is provided", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const token = "AKIA" + "A".repeat(16);
    await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/x.md"],
      readFile: () => `key=${token}`,
      redactionEmitStore: store,
      // workspaceId intentionally omitted — local/offline mode
      claudeMdOverride: "SYS",
    });
    expect(store.countByStatus().pending).toBe(0);
    store.close();
  });
});

describe("prompt-builder × RedactionEmitStore — chain-write unaffected (regression)", () => {
  it("with-store and without-store produce byte-identical prompt.text", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const token = "AKIA" + "Z".repeat(16);
    const input = `meta\nkey=${token}\nfooter`;
    const withStore = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/r.md"],
      readFile: () => input,
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    const withoutStore = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/r.md"],
      readFile: () => input,
      claudeMdOverride: "SYS",
    });
    expect(withStore.text).toBe(withoutStore.text);
    expect(withStore.excerpts[0].excerpt).toBe(withoutStore.excerpts[0].excerpt);
    store.close();
  });

  it("with-store and without-store produce byte-identical excerpts on truncated input", async () => {
    const store = new RedactionEmitStore({ path: ":memory:", inMemory: true });
    const oversize = "abc".repeat(20_000); // > 32KB raw
    const withStore = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/big.md"],
      readFile: () => oversize,
      redactionEmitStore: store,
      workspaceId: WORKSPACE_ID,
      claudeMdOverride: "SYS",
    });
    const withoutStore = await buildIngestionPrompt({
      config: makeConfig(),
      files: ["/raw/big.md"],
      readFile: () => oversize,
      claudeMdOverride: "SYS",
    });
    expect(withStore.excerpts[0].excerpt).toBe(withoutStore.excerpts[0].excerpt);
    expect(withStore.excerpts[0].truncated).toBe(true);
    store.close();
  });
});
