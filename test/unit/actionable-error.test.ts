import { describe, expect, it } from "vitest";
import {
  ActionableError,
  cliAuthError,
  configParseError,
  daemonAlreadyRunningError,
  initTargetNotEmptyError,
  invalidApiKeyError,
  isActionableError,
  looksLikeCliAuthFailure,
  looksLikeFileLock,
  looksLikeNativeBindingFailure,
  looksLikePermissionDenied,
  looksLikePortInUse,
  missingVaultPathError,
  nativeBindingLoadError,
  portInUseError,
  rateLimitedError,
  vaultFileLockedError,
  wikiDirPermissionError,
} from "../../src/utils/actionable-error.js";

describe("ActionableError", () => {
  it("includes summary, suggestions, and docs in message", () => {
    const e = new ActionableError({
      code: "MISSING_VAULT_PATH",
      summary: "Test summary",
      suggestions: ["First step", "Second step"],
      docs: "docs/test.md",
    });
    expect(e.message).toContain("Test summary");
    expect(e.message).toContain("What to try:");
    expect(e.message).toContain("- First step");
    expect(e.message).toContain("- Second step");
    expect(e.message).toContain("Docs: docs/test.md");
  });

  it("preserves the cause chain", () => {
    const cause = new Error("underlying");
    const e = new ActionableError({
      code: "CONFIG_PARSE_ERROR",
      summary: "wrapper",
      suggestions: [],
      cause,
    });
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });

  it("isActionableError narrows correctly", () => {
    const a = missingVaultPathError();
    const b = new Error("plain");
    expect(isActionableError(a)).toBe(true);
    expect(isActionableError(b)).toBe(false);
    expect(isActionableError(null)).toBe(false);
    expect(isActionableError(undefined)).toBe(false);
    expect(isActionableError("string error")).toBe(false);
  });

  it("renders suggestions block only when non-empty", () => {
    const e = new ActionableError({
      code: "MISSING_VAULT_PATH",
      summary: "Just a summary",
      suggestions: [],
    });
    expect(e.message).not.toContain("What to try:");
    expect(e.message).toBe("Just a summary");
  });
});

describe("path 1 — missingVaultPathError", () => {
  it("has the MISSING_VAULT_PATH code + actionable next steps", () => {
    const e = missingVaultPathError();
    expect(e.code).toBe("MISSING_VAULT_PATH");
    expect(e.summary).toMatch(/No Obsidian vault path/);
    expect(e.message).toMatch(/wotw init/);
    expect(e.message).toMatch(/--path/);
    expect(e.message).toMatch(/OBSIDIAN_VAULT_PATH/);
    expect(e.docs).toMatch(/init-walkthrough/);
  });
});

describe("path 2 — configParseError", () => {
  it("wraps cosmiconfig-style parse failures with actionable steps", () => {
    const cause = new Error("unexpected token at line 4");
    const e = configParseError("/path/to/wotw.config.yaml", cause);
    expect(e.code).toBe("CONFIG_PARSE_ERROR");
    expect(e.summary).toContain("/path/to/wotw.config.yaml");
    expect(e.summary).toContain("unexpected token at line 4");
    expect(e.message).toMatch(/yamllint|JSON\.parse/);
    expect(e.message).toMatch(/wotw init/);
    expect((e as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("path 3 — nativeBindingLoadError + matcher", () => {
  it("matches better-sqlite3 binding errors", () => {
    expect(
      looksLikeNativeBindingFailure(new Error("Cannot find module 'better_sqlite3.node'")),
    ).toBe(true);
    expect(
      looksLikeNativeBindingFailure(
        new Error(
          "better-sqlite3/build/Release/better_sqlite3.node was compiled against a different Node.js version (NODE_MODULE_VERSION 108)",
        ),
      ),
    ).toBe(true);
    expect(looksLikeNativeBindingFailure(new Error("ERR_DLOPEN_FAILED: dlopen failed"))).toBe(true);
    expect(
      looksLikeNativeBindingFailure(
        new Error("libstdc++.so.6: version `GLIBCXX_3.4.29' not found (required by sqlite)"),
      ),
    ).toBe(true);
    expect(looksLikeNativeBindingFailure(new Error("dyld: image not found"))).toBe(true);
    expect(looksLikeNativeBindingFailure(new Error("unrelated"))).toBe(false);
  });

  it("nativeBindingLoadError includes rebuild + reinstall guidance", () => {
    const cause = new Error("Cannot find module 'better_sqlite3.node'");
    const e = nativeBindingLoadError("better-sqlite3", cause);
    expect(e.code).toBe("NATIVE_BINDING_LOAD_FAILURE");
    expect(e.message).toMatch(/pnpm rebuild better-sqlite3|npm rebuild/);
    expect(e.message).toMatch(/Node\.js >= 20/);
    expect(e.message).toMatch(/macOS arm64|amd64|Windows/);
  });
});

describe("path 4 — invalidApiKeyError", () => {
  it("emits provider-specific guidance with restart reminder", () => {
    const e = invalidApiKeyError("anthropic", "ANTHROPIC_API_KEY");
    expect(e.code).toBe("INVALID_API_KEY");
    expect(e.summary).toMatch(/401 Unauthorized/);
    expect(e.summary).toMatch(/ANTHROPIC_API_KEY/);
    expect(e.message).toMatch(/wotw stop && wotw start|wotw stop/);
    expect(e.docs).toMatch(/byok/);
  });

  it("handles each provider name", () => {
    expect(invalidApiKeyError("openai", "OPENAI_API_KEY").summary).toContain("openai");
    expect(invalidApiKeyError("gemini", "GOOGLE_API_KEY").summary).toContain("gemini");
  });
});

describe("path 4 (CLI variant) — cliAuthError + looksLikeCliAuthFailure (dogfood #21)", () => {
  it("matches the real CLI 401 stdout signature", () => {
    const real =
      'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"},"request_id":"req_011"} · Please run /login';
    expect(looksLikeCliAuthFailure(real)).toBe(true);
  });

  it("matches each auth-failure phrasing variant", () => {
    expect(looksLikeCliAuthFailure("API Error: 401 unauthorized")).toBe(true);
    expect(looksLikeCliAuthFailure("authentication_error occurred")).toBe(true);
    expect(looksLikeCliAuthFailure("Invalid authentication credentials")).toBe(true);
    expect(looksLikeCliAuthFailure("Please run /login")).toBe(true);
    expect(looksLikeCliAuthFailure("you are not logged in")).toBe(true);
  });

  it("does not match valid JSON edit output", () => {
    expect(looksLikeCliAuthFailure('[{"path":"wiki/x.md","content":"..."}]')).toBe(false);
    expect(looksLikeCliAuthFailure("here is your wiki page")).toBe(false);
  });

  it("cliAuthError points at `claude /login`, not env-var rotation", () => {
    const e = cliAuthError();
    expect(e.code).toBe("INVALID_API_KEY");
    expect(e.summary).toMatch(/Claude Code CLI is not authenticated/);
    expect(e.message).toMatch(/\/login/);
    expect(e.message).toMatch(/wotw stop && wotw start/);
    expect(e.docs).toMatch(/byok/);
  });
});

describe("path 5 — rateLimitedError", () => {
  it("includes retry-after when known", () => {
    const e = rateLimitedError("anthropic", 11);
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.summary).toMatch(/retry after 11s/);
    expect(e.message).toMatch(/concurrency/);
    expect(e.message).toMatch(/wotw status|dead-letter/);
  });

  it("falls back gracefully when retry-after unknown", () => {
    const e = rateLimitedError("openai");
    expect(e.summary).toMatch(/429/);
    expect(e.summary).not.toMatch(/retry after undefined/);
  });
});

describe("path 6 — wikiDirPermissionError + matcher", () => {
  it("matches EACCES / EPERM errors", () => {
    const err = new Error("EACCES: permission denied, mkdir '/root/wiki'");
    (err as { code?: string }).code = "EACCES";
    expect(looksLikePermissionDenied(err)).toBe(true);

    const err2 = new Error("EPERM: operation not permitted");
    (err2 as { code?: string }).code = "EPERM";
    expect(looksLikePermissionDenied(err2)).toBe(true);

    expect(looksLikePermissionDenied(new Error("unrelated"))).toBe(false);
  });

  it("wikiDirPermissionError includes the offending path + chmod hint", () => {
    const cause = new Error("EACCES: permission denied");
    const e = wikiDirPermissionError("/root/wiki", cause);
    expect(e.code).toBe("WIKI_DIR_PERMISSION_DENIED");
    expect(e.summary).toContain("/root/wiki");
    expect(e.message).toMatch(/chmod u\+w|ls -la/);
  });
});

describe("path 7 — vaultFileLockedError + matcher", () => {
  it("matches EBUSY / ETXTBSY / EAGAIN", () => {
    const err = new Error("EBUSY: resource busy or locked");
    (err as { code?: string }).code = "EBUSY";
    expect(looksLikeFileLock(err)).toBe(true);

    const err2 = new Error("EAGAIN: try again");
    (err2 as { code?: string }).code = "EAGAIN";
    expect(looksLikeFileLock(err2)).toBe(true);

    expect(looksLikeFileLock(new Error("unrelated"))).toBe(false);
  });

  it("vaultFileLockedError mentions Obsidian as likely holder", () => {
    const cause = new Error("EBUSY: resource busy or locked");
    const e = vaultFileLockedError("/vault/wiki/some-page.md", cause);
    expect(e.code).toBe("VAULT_FILE_LOCKED");
    expect(e.summary).toContain("/vault/wiki/some-page.md");
    expect(e.message).toMatch(/Obsidian/);
  });
});

describe("path 8 — portInUseError + matcher", () => {
  it("matches EADDRINUSE", () => {
    const err = new Error("listen EADDRINUSE: address already in use :::4317");
    (err as { code?: string }).code = "EADDRINUSE";
    expect(looksLikePortInUse(err)).toBe(true);

    expect(looksLikePortInUse(new Error("unrelated"))).toBe(false);
  });

  it("portInUseError gives platform-specific diagnostic commands", () => {
    const e = portInUseError(4317);
    expect(e.code).toBe("PORT_IN_USE");
    expect(e.summary).toMatch(/4317/);
    expect(e.message).toMatch(/lsof -iTCP:4317|netstat.*4317/);
    expect(e.message).toMatch(/server\.port/);
  });
});

describe("path 9 — daemonAlreadyRunningError", () => {
  it("points at wotw status + wotw stop for resolution", () => {
    const e = daemonAlreadyRunningError("/var/run/wotw.lock");
    expect(e.code).toBe("DAEMON_ALREADY_RUNNING");
    expect(e.summary).toContain("/var/run/wotw.lock");
    expect(e.message).toMatch(/wotw status/);
    expect(e.message).toMatch(/wotw stop/);
    expect(e.message).toMatch(/--force/);
  });
});

describe("path 10 — initTargetNotEmptyError", () => {
  it("lists conflicting entries with truncation past 5", () => {
    const e = initTargetNotEmptyError("/target", ["a", "b", "c", "d", "e", "f", "g"]);
    expect(e.code).toBe("INIT_TARGET_NOT_EMPTY");
    expect(e.summary).toContain("/target");
    expect(e.message).toMatch(/a, b, c, d, e/);
    expect(e.message).toMatch(/\(\+2 more\)/);
  });

  it("renders short lists without the truncation suffix", () => {
    const e = initTargetNotEmptyError("/target", ["a", "b"]);
    expect(e.message).toMatch(/a, b/);
    expect(e.message).not.toMatch(/more\)/);
  });

  it("recommends --force for the explicit override path", () => {
    const e = initTargetNotEmptyError("/target", ["file"]);
    expect(e.message).toMatch(/--force/);
  });
});

describe("end-to-end shape — every path", () => {
  const paths: { name: string; build: () => ActionableError }[] = [
    { name: "MISSING_VAULT_PATH", build: () => missingVaultPathError() },
    {
      name: "CONFIG_PARSE_ERROR",
      build: () => configParseError("/p", new Error("x")),
    },
    {
      name: "NATIVE_BINDING_LOAD_FAILURE",
      build: () => nativeBindingLoadError("better-sqlite3", new Error("x")),
    },
    {
      name: "INVALID_API_KEY",
      build: () => invalidApiKeyError("anthropic", "ANTHROPIC_API_KEY"),
    },
    { name: "RATE_LIMITED", build: () => rateLimitedError("anthropic", 5) },
    {
      name: "WIKI_DIR_PERMISSION_DENIED",
      build: () => wikiDirPermissionError("/p", new Error("x")),
    },
    {
      name: "VAULT_FILE_LOCKED",
      build: () => vaultFileLockedError("/p", new Error("x")),
    },
    { name: "PORT_IN_USE", build: () => portInUseError(4317) },
    {
      name: "DAEMON_ALREADY_RUNNING",
      build: () => daemonAlreadyRunningError("/p"),
    },
    {
      name: "INIT_TARGET_NOT_EMPTY",
      build: () => initTargetNotEmptyError("/p", ["x"]),
    },
  ];

  for (const { name, build } of paths) {
    it(`${name}: has docs link + at least one suggestion + non-empty summary`, () => {
      const e = build();
      expect(e.code).toBe(name);
      expect(e.summary.length).toBeGreaterThan(0);
      expect(e.suggestions.length).toBeGreaterThan(0);
      expect(e.docs).toBeDefined();
      expect(e.message).toMatch(/What to try:/);
    });
  }
});
