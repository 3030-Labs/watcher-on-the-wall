/**
 * Unit tests for the CLI invoker.
 *
 * The invoker spawns a subprocess and detects file writes via a before/after
 * snapshot diff of the working directory. We exercise it without a real
 * `claude` binary by pointing `cliPath` at a tiny shell script that:
 *
 *   - reads the user prompt from stdin (matches our contract)
 *   - writes a file under cwd (so the diff picks it up)
 *   - prints a final-text marker on stdout
 *   - exits 0 (success) or non-zero (failure path)
 *
 * Tests cover:
 *
 *   - happy path: stdout captured, writtenPaths includes the new file, cost=0
 *   - non-zero exit surfaces as success=false with stop_reason set
 *   - timeout-driven termination is non-fatal (returns success=false instead
 *     of throwing) and the timer is unrefed so it doesn't block test exit
 *   - the snapshot diff ignores `.git`, `node_modules`, and `raw/`
 *   - large prompts pass through stdin without ARG_MAX issues
 */

// vi.mock must be hoisted. We wrap the real spawn and optionally sabotage
// stdin.write for the CRITICAL-2 test via a shared flag.
let _sabotageStdin = false;

import { vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const mod = await importOriginal<typeof import("node:child_process")>();
  return {
    ...mod,
    spawn: (...args: Parameters<typeof mod.spawn>): ReturnType<typeof mod.spawn> => {
      const child = mod.spawn(...args);
      if (_sabotageStdin && child.stdin) {
        // Override write so it throws synchronously, simulating EPIPE on
        // a destroyed stream. The real spawn proceeds normally otherwise.
        child.stdin.write = (): boolean => {
          throw new Error("write EPIPE");
        };
        // Also make end() a no-op so the test doesn't hang when the
        // source code's try/catch skips end() after write throws.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        child.stdin.end = (..._endArgs: any[]): any => child.stdin;
      }
      return child;
    },
  };
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { invokeClaudeCli } from "../../src/ingestion/cli-invoker.js";
import type { InvokeOptions } from "../../src/ingestion/llm-invoker.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-cli-inv-"));
}

/**
 * Write a stand-in `claude` binary as a shell script. Returns the absolute
 * path to the script. The body parameter is the shell snippet to execute
 * after stdin is consumed.
 */
function writeFakeCli(dir: string, body: string): string {
  const path = join(dir, "fake-claude.sh");
  // Drain stdin so callers that pipe a prompt don't hang us; then run body.
  const script = `#!/bin/sh
cat > /dev/null
${body}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

/**
 * Write a stand-in `claude` binary that does NOT read from stdin.
 * Used by the CRITICAL-2 test where stdin.write throws and end() is
 * never called, so a script that reads stdin would hang forever.
 */
function writeFakeCliNoStdin(dir: string, body: string): string {
  const path = join(dir, "fake-claude-nostdin.sh");
  const script = `#!/bin/sh
${body}
`;
  writeFileSync(path, script);
  chmodSync(path, 0o755);
  return path;
}

const baseOpts = (cwd: string): InvokeOptions => ({
  cwd,
  systemPrompt: "you are a test agent",
  userPrompt: "do something",
  model: "claude-sonnet-4-5",
  maxTurns: 5,
});

describe("cli-invoker \u2014 happy path", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
    mkdirSync(join(workdir, "wiki"), { recursive: true });
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "captures stdout, detects written files, reports cost=0",
    async () => {
      const fakeCli = writeFakeCli(
        workdir,
        `mkdir -p "${workdir}/wiki/concepts"
echo "wrote it" > "${workdir}/wiki/concepts/new-page.md"
echo "FAKE_CLI_DONE"`,
      );

      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        baseOpts(workdir),
      );

      expect(result.success).toBe(true);
      expect(result.totalCostUsd).toBe(0);
      expect(result.inputTokens).toBeGreaterThan(0);
      expect(result.outputTokens).toBeGreaterThan(0);
      expect(result.finalText).toContain("FAKE_CLI_DONE");
      expect(result.writtenPaths.length).toBeGreaterThan(0);
      const wroteOurFile = result.writtenPaths.some((p) => p.endsWith("new-page.md"));
      expect(wroteOurFile).toBe(true);
      expect(result.stopReason).toBe("end_turn");
    },
  );
});

describe("cli-invoker \u2014 failure modes", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "non-zero exit surfaces as success=false with exit_code stop reason",
    async () => {
      const fakeCli = writeFakeCli(workdir, `echo "boom" 1>&2; exit 7`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        baseOpts(workdir),
      );
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe("exit_7");
      expect(Array.isArray(result.writtenPaths)).toBe(true);
    },
  );

  it.skipIf(platform() === "win32")(
    "kills the subprocess on timeout and reports failure",
    async () => {
      const fakeCli = writeFakeCli(workdir, `sleep 5; echo "should not see"`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5", timeoutMs: 200 },
        baseOpts(workdir),
      );
      expect(result.success).toBe(false);
      expect(result.stopReason).not.toBe("end_turn");
    },
  );
});

describe("cli-invoker \u2014 snapshot diff hygiene", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
    mkdirSync(join(workdir, "wiki"), { recursive: true });
    mkdirSync(join(workdir, ".git"), { recursive: true });
    mkdirSync(join(workdir, "node_modules"), { recursive: true });
    mkdirSync(join(workdir, "raw"), { recursive: true });
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "ignores .git, node_modules, and raw/ when diffing the wiki tree",
    async () => {
      const fakeCli = writeFakeCli(
        workdir,
        `echo "git noise" > "${workdir}/.git/HEAD"
echo "modules noise" > "${workdir}/node_modules/index.js"
echo "raw noise" > "${workdir}/raw/source.txt"
echo "wiki content" > "${workdir}/wiki/page.md"`,
      );

      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        baseOpts(workdir),
      );

      expect(result.success).toBe(true);
      expect(result.writtenPaths.length).toBe(1);
      expect(result.writtenPaths[0]).toMatch(/wiki[/\\]page\.md$/);
    },
  );
});

describe("cli-invoker \u2014 large prompts via stdin", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "passes a 256KB user prompt through stdin without truncation",
    async () => {
      const bigPrompt = "x".repeat(256 * 1024);
      const fakeCli = join(workdir, "fake-claude-stdin.sh");
      writeFileSync(
        fakeCli,
        `#!/bin/sh
COUNT=$(wc -c)
echo "stdin_bytes=$COUNT"
`,
      );
      chmodSync(fakeCli, 0o755);

      const opts: InvokeOptions = {
        ...baseOpts(workdir),
        userPrompt: bigPrompt,
      };
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        opts,
      );

      expect(result.success).toBe(true);
      const match = result.finalText.match(/stdin_bytes=\s*(\d+)/);
      expect(match).not.toBeNull();
      const bytes = Number(match?.[1] ?? "0");
      expect(bytes).toBe(bigPrompt.length);
    },
  );
});

describe("cli-invoker \u2014 abort controller", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "cancels the subprocess when the abort signal fires",
    async () => {
      const fakeCli = writeFakeCli(workdir, `sleep 5; echo "should not see"`);
      const abort = new AbortController();
      const promise = invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        { ...baseOpts(workdir), abortController: abort },
      );
      setTimeout(() => abort.abort(), 50);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stopReason).not.toBe("end_turn");
    },
  );
});

describe("cli-invoker \u2014 CRITICAL-2: stdin write failure", () => {
  // REVERT CHECK: If the stdinFailed guard (lines ~127-134 and ~179-195
  // in cli-invoker.ts) is reverted -- specifically the try/catch around
  // child.stdin.write() and the stdinFailed branch that returns
  // { success: false, stopReason: "stdin_write_failed" } -- this test
  // will fail. Without the try/catch, the synchronous throw from
  // stdin.write() would propagate as an unhandled exception instead of
  // being caught and surfaced as a clean failure result.
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
    _sabotageStdin = true;
  });
  afterEach(() => {
    _sabotageStdin = false;
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "returns success=false with stdin_write_failed when stdin.write throws",
    async () => {
      // The vi.mock wrapper above intercepts spawn() and makes stdin.write
      // throw synchronously when _sabotageStdin is true. We use a script
      // that does NOT read from stdin so it exits quickly even when stdin
      // is never written/closed.
      const fakeCli = writeFakeCliNoStdin(workdir, `echo "ok"; exit 0`);

      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        baseOpts(workdir),
      );

      // The stdinFailed guard must catch the write error and return failure
      // even though the process exits with code 0.
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe("stdin_write_failed");
      expect(result.writtenPaths).toEqual([]);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
    },
  );
});

describe("cli-invoker \u2014 CRITICAL-3: exact token estimation", () => {
  // REVERT CHECK: If the Math.ceil(byteLength/4) formula at lines ~198-207
  // in cli-invoker.ts is reverted to 0 or removed, inputTokens and
  // outputTokens will be wrong. These tests pin the exact expected values.
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
    mkdirSync(join(workdir, "wiki"), { recursive: true });
  });
  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  it.skipIf(platform() === "win32")(
    "inputTokens equals Math.ceil(Buffer.byteLength(prompt) / 4)",
    async () => {
      const prompt = "do something";
      const expectedInputTokens = Math.ceil(Buffer.byteLength(prompt, "utf8") / 4);
      // "do something" is 12 ASCII bytes -> ceil(12/4) = 3
      expect(expectedInputTokens).toBe(3);

      const fakeCli = writeFakeCli(workdir, `echo "ok"`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        { ...baseOpts(workdir), userPrompt: prompt },
      );

      expect(result.success).toBe(true);
      expect(result.inputTokens).toBe(expectedInputTokens);
    },
  );

  it.skipIf(platform() === "win32")(
    "outputTokens equals Math.ceil(totalFileSize / 4) for written files",
    async () => {
      // Write a file with exactly 10 bytes of content ("0123456789")
      // -> ceil(10/4) = 3 outputTokens
      const fakeCli = writeFakeCli(workdir, `printf '0123456789' > "${workdir}/wiki/out.md"`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        baseOpts(workdir),
      );

      expect(result.success).toBe(true);
      expect(result.outputTokens).toBe(Math.ceil(10 / 4)); // 3
    },
  );

  it.skipIf(platform() === "win32")(
    "multi-byte UTF-8 prompt produces correct inputTokens",
    async () => {
      // Each emoji is 4 UTF-8 bytes; 5 emojis = 20 bytes -> ceil(20/4) = 5
      const prompt = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}\u{1F604}";
      const expectedBytes = Buffer.byteLength(prompt, "utf8");
      expect(expectedBytes).toBe(20);
      const expectedTokens = Math.ceil(expectedBytes / 4);
      expect(expectedTokens).toBe(5);

      const fakeCli = writeFakeCli(workdir, `echo "ok"`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5" },
        { ...baseOpts(workdir), userPrompt: prompt },
      );

      expect(result.success).toBe(true);
      expect(result.inputTokens).toBe(expectedTokens);
    },
  );
});
