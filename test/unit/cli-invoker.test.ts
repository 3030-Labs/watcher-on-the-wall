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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const baseOpts = (cwd: string): InvokeOptions => ({
  cwd,
  systemPrompt: "you are a test agent",
  userPrompt: "do something",
  model: "claude-sonnet-4-5",
  maxTurns: 5,
});

describe("cli-invoker — happy path", () => {
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
        // Touch a new file under wiki/ then print a marker on stdout.
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
      // CRITICAL-3: CLI mode now estimates tokens from byte sizes (4 bytes/token).
      // userPrompt is "do something" (12 bytes) → ceil(12/4) = 3 inputTokens.
      // The written file contains "wrote it\n" → outputTokens > 0.
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

describe("cli-invoker — failure modes", () => {
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
      // Even on failure we still return the (empty) writtenPaths, not throw.
      expect(Array.isArray(result.writtenPaths)).toBe(true);
    },
  );

  it.skipIf(platform() === "win32")(
    "kills the subprocess on timeout and reports failure",
    async () => {
      // sleep longer than the timeout so it has to be killed
      const fakeCli = writeFakeCli(workdir, `sleep 5; echo "should not see"`);
      const result = await invokeClaudeCli(
        { cliPath: fakeCli, cliModel: "claude-sonnet-4-5", timeoutMs: 200 },
        baseOpts(workdir),
      );
      expect(result.success).toBe(false);
      // The timer fires SIGTERM; depending on timing the child reports
      // either a signal or an exit code, but never end_turn.
      expect(result.stopReason).not.toBe("end_turn");
    },
  );
});

describe("cli-invoker — snapshot diff hygiene", () => {
  let workdir: string;
  beforeEach(() => {
    workdir = tmpRoot();
    mkdirSync(join(workdir, "wiki"), { recursive: true });
    // Create the noise dirs the snapshot must ignore.
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
        // Create files in all the ignored dirs AND one in wiki/.
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
      // Only wiki/page.md should appear in writtenPaths.
      expect(result.writtenPaths.length).toBe(1);
      expect(result.writtenPaths[0]).toMatch(/wiki[/\\]page\.md$/);
    },
  );
});

describe("cli-invoker — large prompts via stdin", () => {
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
      // 256KB — well above any plausible argv limit but tiny for stdin.
      const bigPrompt = "x".repeat(256 * 1024);
      // Have the fake CLI report stdin byte count via wc -c.
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
      // wc -c output includes leading whitespace; just check the number is
      // large enough that stdin clearly got the big prompt.
      const match = result.finalText.match(/stdin_bytes=\s*(\d+)/);
      expect(match).not.toBeNull();
      const bytes = Number(match?.[1] ?? "0");
      expect(bytes).toBe(bigPrompt.length);
    },
  );
});

describe("cli-invoker — abort controller", () => {
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
      // Fire the abort almost immediately.
      setTimeout(() => abort.abort(), 50);
      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.stopReason).not.toBe("end_turn");
    },
  );

  it("verifies the script-based test setup is sane", () => {
    // Sanity check so the suite doesn't fall through to zero tests on Win32.
    expect(existsSync(workdir)).toBe(true);
  });
});
