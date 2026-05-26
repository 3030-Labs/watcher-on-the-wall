/**
 * Integration-style tests for `wotw init` wizard — exercised via the
 * `runInit` non-interactive path. Every test scaffolds into a tmp dir and
 * asserts the resulting structure, so we get real filesystem coverage
 * without depending on clack's TTY prompts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../../src/cli/commands/init.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "wotw-init-wizard-"));
}

const WIKI_CATEGORIES = ["concepts", "entities", "sources", "comparisons", "syntheses", "queries"];

let savedCwd: string;
let savedObsidianEnv: string | undefined;

beforeEach(() => {
  savedCwd = process.cwd();
  // OBSIDIAN_VAULT_PATH would override --path resolution; isolate the suite
  // from whatever the operator has in their shell.
  savedObsidianEnv = process.env.OBSIDIAN_VAULT_PATH;
  delete process.env.OBSIDIAN_VAULT_PATH;
});

afterEach(() => {
  // A couple of tests chdir into the tmp dir; always restore so we don't
  // poison sibling tests.
  process.chdir(savedCwd);
  if (savedObsidianEnv !== undefined) {
    process.env.OBSIDIAN_VAULT_PATH = savedObsidianEnv;
  } else {
    delete process.env.OBSIDIAN_VAULT_PATH;
  }
});

describe("runInit — non-interactive scaffolding", () => {
  it("creates the full vault layout with the default config when given --path", async () => {
    const root = tmp();
    const result = await runInit({ path: root, yes: true, nonInteractive: true, open: false });

    expect(result.root).toBe(root);
    expect(result.alreadyInitialized).toBe(false);
    expect(result.createdFreshVault).toBe(true);
    expect(result.overlaySubdir).toBeNull();

    // Top-level files
    expect(existsSync(join(root, "wotw.yaml"))).toBe(true);
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(root, ".gitignore"))).toBe(true);

    // Directories
    expect(existsSync(join(root, "raw"))).toBe(true);
    expect(existsSync(join(root, "wiki"))).toBe(true);
    expect(existsSync(join(root, "wiki", "index.md"))).toBe(true);
    expect(existsSync(join(root, "wiki", "log.md"))).toBe(true);
    for (const cat of WIKI_CATEGORIES) {
      expect(existsSync(join(root, "wiki", cat))).toBe(true);
    }

    // Getting Started page
    expect(existsSync(join(root, "wiki", "getting-started.md"))).toBe(true);

    // Fresh-vault .obsidian defaults
    expect(existsSync(join(root, ".obsidian", "app.json"))).toBe(true);
    expect(existsSync(join(root, ".obsidian", "appearance.json"))).toBe(true);
    expect(existsSync(join(root, ".obsidian", "graph.json"))).toBe(true);

    // Git repo initialized
    expect(existsSync(join(root, ".git"))).toBe(true);
  });

  it("defaults to process.cwd() when no path is provided", async () => {
    const root = tmp();
    process.chdir(root);
    const result = await runInit({ yes: true, nonInteractive: true, open: false });
    expect(result.root).toBe(root);
    expect(existsSync(join(root, "wiki", "index.md"))).toBe(true);
    expect(existsSync(join(root, "wotw.yaml"))).toBe(true);
  });

  it("replaces the __WOTW_UPDATED_ISO__ placeholder in wiki/index.md", async () => {
    const root = tmp();
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const indexBody = readFileSync(join(root, "wiki", "index.md"), "utf8");
    expect(indexBody).not.toContain("__WOTW_UPDATED_ISO__");
    // Must still contain the sentinel block used by index-manager.
    expect(indexBody).toContain("<!-- wotw:index:start -->");
    expect(indexBody).toContain("<!-- wotw:index:end -->");
    // ISO timestamp dropped into the frontmatter.
    expect(indexBody).toMatch(/updated: \d{4}-\d{2}-\d{2}T/);
  });

  it("creates getting-started.md with replaced timestamp and valid frontmatter", async () => {
    const root = tmp();
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const body = readFileSync(join(root, "wiki", "getting-started.md"), "utf8");
    expect(body).not.toContain("__WOTW_UPDATED_ISO__");
    expect(body).toContain("title: Getting Started");
    expect(body).toContain("category: concept");
    expect(body).toContain("wotw start");
    expect(body).toContain("wotw search");
    expect(body).toContain("wotw approve");
  });

  it("renders wotw.yaml with sibling raw/wiki paths relative to the vault root", async () => {
    const root = tmp();
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const configBody = readFileSync(join(root, "wotw.yaml"), "utf8");
    expect(configBody).toContain("wiki_root: .");
    expect(configBody).toContain("raw_path: ./raw");
    expect(configBody).toContain("mode: auto");
    expect(configBody).toContain("cli_model: claude-sonnet-4-5");
  });

  it("is idempotent — re-running against the same path is a no-op", async () => {
    const root = tmp();
    const first = await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    expect(first.alreadyInitialized).toBe(false);

    // Mutate a file to prove the second pass doesn't touch it.
    const indexPath = join(root, "wiki", "index.md");
    writeFileSync(indexPath, "USER_EDIT");

    const second = await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    expect(second.alreadyInitialized).toBe(true);
    expect(second.root).toBe(root);
    // Second pass did not overwrite the mutation.
    expect(readFileSync(indexPath, "utf8")).toBe("USER_EDIT");
  });

  it("with --force, overwrites an existing scaffold", async () => {
    const root = tmp();
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const indexPath = join(root, "wiki", "index.md");
    writeFileSync(indexPath, "USER_EDIT");

    const forced = await runInit({
      path: root,
      yes: true,
      nonInteractive: true,
      open: false,
      force: true,
    });
    expect(forced.alreadyInitialized).toBe(false);
    // --force restored the template.
    expect(readFileSync(indexPath, "utf8")).not.toBe("USER_EDIT");
    expect(readFileSync(indexPath, "utf8")).toContain("<!-- wotw:index:start -->");
  });
});

describe("runInit — .gitignore handling", () => {
  it("writes a full .gitignore when none exists", async () => {
    const root = tmp();
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const body = readFileSync(join(root, ".gitignore"), "utf8");
    expect(body).toContain(".obsidian/workspace.json");
    expect(body).toContain(".wotw/");
  });

  it("appends wotw rules to an existing .gitignore", async () => {
    const root = tmp();
    const gitignorePath = join(root, ".gitignore");
    writeFileSync(gitignorePath, "node_modules\ndist\n");
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    const body = readFileSync(gitignorePath, "utf8");
    // Preserved existing content
    expect(body).toContain("node_modules");
    expect(body).toContain("dist");
    // Added wotw block
    expect(body).toContain(".wotw/");
    expect(body).toContain("# wotw");
  });

  it("leaves an existing .gitignore alone when it already mentions .wotw/", async () => {
    const root = tmp();
    const gitignorePath = join(root, ".gitignore");
    const preexisting = "custom_stuff\n.wotw/\n";
    writeFileSync(gitignorePath, preexisting);
    await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    expect(readFileSync(gitignorePath, "utf8")).toBe(preexisting);
  });
});

describe("runInit — overlay into existing Obsidian vault", () => {
  it("detects a pre-existing .obsidian/ and does not re-create defaults", async () => {
    const root = tmp();
    // Pretend this is an existing Obsidian vault with a user-customized
    // appearance.json we don't want to touch.
    const obsDir = join(root, ".obsidian");
    mkdirSync(obsDir);
    const appearancePath = join(obsDir, "appearance.json");
    writeFileSync(appearancePath, '{"accentColor":"#ff00ff"}');

    const result = await runInit({ path: root, yes: true, nonInteractive: true, open: false });
    expect(result.createdFreshVault).toBe(false);
    // User's appearance.json untouched
    expect(readFileSync(appearancePath, "utf8")).toBe('{"accentColor":"#ff00ff"}');
    // But wiki/ + raw/ still scaffolded at the vault root (non-interactive
    // overlay falls through to the vault root — the subdir prompt only
    // fires when the user interactively declines the overlay).
    expect(existsSync(join(root, "raw"))).toBe(true);
    expect(existsSync(join(root, "wiki"))).toBe(true);
    for (const cat of WIKI_CATEGORIES) {
      expect(existsSync(join(root, "wiki", cat))).toBe(true);
    }
  });
});
