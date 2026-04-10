/**
 * Unit tests for the DeadLetterQueue JSONL sink. Real I/O via a tmpdir
 * (pattern copied from cost-tracker.test.ts) — the file format is a
 * public contract with operators, so tests validate the on-disk shape.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeadLetterQueue } from "../../src/ingestion/dead-letter.js";
import type { WatcherBatch } from "../../src/watcher/index.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "wotw-dlq-"));
}

function makeBatch(id = "batch-test-1"): Pick<WatcherBatch, "id" | "paths"> {
  return {
    id,
    paths: ["/abs/raw/a.md", "/abs/raw/b.md"],
  };
}

describe("DeadLetterQueue", () => {
  it("is disabled when path is empty (never writes)", async () => {
    const dlq = new DeadLetterQueue({ path: "" });
    expect(dlq.enabled).toBe(false);
    await dlq.record(makeBatch(), new Error("boom"));
    expect(await dlq.count()).toBe(0);
    expect(await dlq.list()).toEqual([]);
  });

  it("records a failure as a single JSONL line", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    const dlq = new DeadLetterQueue({ path: file, runtimeMode: "cli" });
    await dlq.record(makeBatch("batch-1"), new Error("invoke failed"));
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text.trim()) as Record<string, unknown>;
    expect(parsed.batch_id).toBe("batch-1");
    expect(parsed.error).toBe("invoke failed");
    expect(parsed.reason).toBe("add");
    expect(parsed.mode).toBe("cli");
    expect(parsed.retry).toBe(false);
    expect(parsed.files).toEqual(["/abs/raw/a.md", "/abs/raw/b.md"]);
  });

  it("appends multiple records as distinct lines", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    const dlq = new DeadLetterQueue({ path: file });
    await dlq.record(makeBatch("b1"), new Error("e1"));
    await dlq.record(makeBatch("b2"), new Error("e2"), "delete");
    await dlq.record(makeBatch("b3"), new Error("e3"));
    const records = await dlq.list();
    expect(records).toHaveLength(3);
    expect(records[0]?.batch_id).toBe("b1");
    expect(records[1]?.reason).toBe("delete");
    expect(records[2]?.error).toBe("e3");
    expect(await dlq.count()).toBe(3);
  });

  it("coerces non-Error throwables to Error", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    const dlq = new DeadLetterQueue({ path: file });
    await dlq.record(makeBatch(), "string error");
    await dlq.record(makeBatch(), { code: 42 });
    const records = await dlq.list();
    expect(records).toHaveLength(2);
    expect(records[0]?.error).toBe("string error");
    // JSON.stringify on a plain object should roundtrip as its JSON form.
    expect(records[1]?.error).toContain("42");
  });

  it("survives a corrupt ledger line without crashing", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    writeFileSync(
      file,
      `not-json\n{"broken\n${JSON.stringify({
        timestamp: "2026-04-07T00:00:00.000Z",
        batch_id: "ok",
        files: [],
        reason: "add",
        mode: "api",
        error: "ok",
        retry: false,
      })}\n`,
      "utf8",
    );
    const dlq = new DeadLetterQueue({ path: file });
    const records = await dlq.list();
    // Only the valid record should come back.
    expect(records).toHaveLength(1);
    expect(records[0]?.batch_id).toBe("ok");
    // count() ignores JSON validity — it's a line count.
    expect(await dlq.count()).toBe(3);
  });

  it("list(limit) returns the N most recent records", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    const dlq = new DeadLetterQueue({ path: file });
    for (let i = 0; i < 5; i++) {
      await dlq.record(makeBatch(`batch-${i}`), new Error(`e${i}`));
    }
    const tail = await dlq.list(2);
    expect(tail).toHaveLength(2);
    expect(tail[0]?.batch_id).toBe("batch-3");
    expect(tail[1]?.batch_id).toBe("batch-4");
  });

  it("clear() removes the ledger file", async () => {
    const file = join(tmpDir(), "failed.jsonl");
    const dlq = new DeadLetterQueue({ path: file });
    await dlq.record(makeBatch(), new Error("boom"));
    expect(existsSync(file)).toBe(true);
    await dlq.clear();
    expect(existsSync(file)).toBe(false);
    // Idempotent — a second clear is a no-op.
    await dlq.clear();
    expect(await dlq.count()).toBe(0);
  });
});
