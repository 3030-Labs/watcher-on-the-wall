import { describe, expect, it } from "vitest";
import { parseDaemonEditsResponse, resolveEditPath } from "../../../src/llm/edits.js";

/**
 * Unit tests for the shared daemon-edits parser + path resolver.
 *
 * Consumed by heal-handlers (Phase 5) + ingestion-queue (Phase 6) +
 * future call sites. Drift across consumers is structurally impossible
 * because the parser + resolver are a single shared module.
 */

describe("parseDaemonEditsResponse", () => {
  it("parses a clean JSON edits envelope", () => {
    const text = '{ "edits": [ { "path": "wiki/concepts/x.md", "content": "body" } ] }';
    const r = parseDaemonEditsResponse(text);
    expect(r).not.toBeNull();
    expect(r!.edits).toHaveLength(1);
    expect(r!.edits[0]).toEqual({ path: "wiki/concepts/x.md", content: "body" });
  });

  it("extracts JSON wrapped in surrounding text", () => {
    const text =
      'Here are the edits:\n\n{ "edits": [ { "path": "a.md", "content": "1" } ] }\n\nDone.';
    const r = parseDaemonEditsResponse(text);
    expect(r).not.toBeNull();
    expect(r!.edits).toHaveLength(1);
  });

  it("extracts JSON wrapped in markdown code fences", () => {
    const text = '```json\n{ "edits": [{"path":"a.md","content":"x"}] }\n```';
    const r = parseDaemonEditsResponse(text);
    expect(r).not.toBeNull();
    expect(r!.edits[0].path).toBe("a.md");
  });

  it("returns null on empty string", () => {
    expect(parseDaemonEditsResponse("")).toBeNull();
    expect(parseDaemonEditsResponse("   \n  ")).toBeNull();
  });

  it("returns null on text with no JSON object", () => {
    expect(parseDaemonEditsResponse("This is plain text.")).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    expect(parseDaemonEditsResponse('{ "edits": [ ')).toBeNull();
  });

  it("returns null when JSON has no edits array", () => {
    expect(parseDaemonEditsResponse('{ "other": 1 }')).toBeNull();
  });

  it("filters out edits missing path or content", () => {
    const text =
      '{ "edits": [' +
      ' { "path": "good.md", "content": "ok" },' +
      ' { "path": "missing-content.md" },' +
      ' { "content": "missing-path" },' +
      ' { "path": "", "content": "empty-path" },' +
      ' { "path": "extra.md", "content": "ok2", "extra": "field" }' +
      " ] }";
    const r = parseDaemonEditsResponse(text);
    expect(r).not.toBeNull();
    // Two valid: good.md and extra.md (extra-field-tolerated).
    expect(r!.edits).toHaveLength(2);
    expect(r!.edits.map((e) => e.path)).toEqual(["good.md", "extra.md"]);
  });

  it("handles edits with multi-line content correctly", () => {
    const content = "---\ntitle: Test\n---\n\nBody line 1\nBody line 2";
    const text = JSON.stringify({ edits: [{ path: "x.md", content }] });
    const r = parseDaemonEditsResponse(text);
    expect(r).not.toBeNull();
    expect(r!.edits[0].content).toBe(content);
  });

  it("returns empty edits array when model says no changes needed", () => {
    const r = parseDaemonEditsResponse('{ "edits": [] }');
    expect(r).not.toBeNull();
    expect(r!.edits).toEqual([]);
  });
});

describe("resolveEditPath", () => {
  const wikiRoot = "/tmp/wiki-root";

  it("accepts wiki-relative paths", () => {
    expect(resolveEditPath(wikiRoot, "wiki/concepts/x.md")).toBe(
      "/tmp/wiki-root/wiki/concepts/x.md",
    );
  });

  it("accepts absolute paths within wiki_root", () => {
    expect(resolveEditPath(wikiRoot, "/tmp/wiki-root/wiki/concepts/y.md")).toBe(
      "/tmp/wiki-root/wiki/concepts/y.md",
    );
  });

  it("rejects relative paths that escape wiki_root via ..", () => {
    expect(resolveEditPath(wikiRoot, "../etc/passwd")).toBeNull();
    expect(resolveEditPath(wikiRoot, "wiki/../../etc/passwd")).toBeNull();
  });

  it("rejects absolute paths outside wiki_root", () => {
    expect(resolveEditPath(wikiRoot, "/etc/passwd")).toBeNull();
    expect(resolveEditPath(wikiRoot, "/tmp/other-root/x.md")).toBeNull();
  });

  it("rejects empty path", () => {
    expect(resolveEditPath(wikiRoot, "")).toBeNull();
  });

  it("accepts wiki_root itself (corner case)", () => {
    // Daemon caller is expected to validate this further if needed (a
    // bare wiki_root is not a file edit), but the resolver allows it.
    expect(resolveEditPath(wikiRoot, ".")).toBe("/tmp/wiki-root");
  });

  it("accepts paths that resolve to subdirectories of wiki_root", () => {
    expect(resolveEditPath(wikiRoot, "wiki/syntheses/synth-1.md")).toBe(
      "/tmp/wiki-root/wiki/syntheses/synth-1.md",
    );
  });
});
