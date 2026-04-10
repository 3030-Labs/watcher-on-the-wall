/**
 * Integration test for the git committer — uses a real temp git repo.
 *
 * Verifies:
 *   - a fresh wiki dir gets a git repo on first commitWikiChanges call
 *   - subsequent commits stage only the requested files
 *   - idempotent: calling commitWikiChanges with no dirty files is a no-op
 *   - commit message includes the operation id and metadata
 *   - paths outside the wiki root are rejected
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitWikiChanges } from "../../src/ingestion/git-committer.js";
import { ensureGitRepo, git, isGitRepo } from "../../src/utils/git.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "wotw-git-"));
}

describe("commitWikiChanges", () => {
  it("initializes a git repo when called on a fresh wiki dir", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
    // First call with no paths — the only effect should be repo initialization.
    const result = await commitWikiChanges({
      wikiRoot: root,
      paths: [],
      operationId: "init",
      operation: "init",
    });
    expect(isGitRepo(root)).toBe(true);
    expect(result.committed).toBe(false);
    expect(result.reason).toContain("no eligible paths");
  });

  it("stages and commits a real file change after init", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
    await ensureGitRepo(root, "chore: wotw init");
    // Now write a file and commit it.
    const file = join(root, "wiki", "concepts", "alpha.md");
    writeFileSync(file, "---\ntitle: Alpha\n---\nbody");
    const result = await commitWikiChanges({
      wikiRoot: root,
      paths: [file],
      operationId: "op1",
      operation: "ingest",
      metadata: { cost_usd: "0.01" },
    });
    expect(result.committed).toBe(true);
    expect(result.sha).toMatch(/^[0-9a-f]+$/);
    expect(result.fileCount).toBe(1);
    expect(result.message).toContain("wotw: ingest op1");
    expect(result.message).toContain("cost_usd: 0.01");
  });

  it("stages only the requested paths, leaving other dirty files alone", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "wiki", "concepts"), { recursive: true });
    await ensureGitRepo(root, "chore: wotw init");

    const alpha = join(root, "wiki", "concepts", "alpha.md");
    const beta = join(root, "wiki", "concepts", "beta.md");
    const gamma = join(root, "wiki", "concepts", "gamma.md");
    writeFileSync(alpha, "A1");
    writeFileSync(beta, "B1");
    writeFileSync(gamma, "G1");

    // Commit alpha and beta, but not gamma.
    const result = await commitWikiChanges({
      wikiRoot: root,
      paths: [alpha, beta],
      operationId: "op1",
      operation: "ingest",
    });
    expect(result.committed).toBe(true);
    expect(result.fileCount).toBe(2);

    // Gamma must still be untracked.
    const g = git(root);
    const status = await g.status();
    expect(status.not_added.some((p) => p.endsWith("gamma.md"))).toBe(true);
    expect(status.not_added.some((p) => p.endsWith("alpha.md"))).toBe(false);
    expect(status.not_added.some((p) => p.endsWith("beta.md"))).toBe(false);
  });

  it("returns committed=false when no files are dirty", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "wiki"), { recursive: true });
    await ensureGitRepo(root, "chore: wotw init");
    const file = join(root, "wiki", "alpha.md");
    writeFileSync(file, "hello");
    await commitWikiChanges({
      wikiRoot: root,
      paths: [file],
      operationId: "op1",
      operation: "ingest",
    });
    // Second call with the same unchanged file.
    const second = await commitWikiChanges({
      wikiRoot: root,
      paths: [file],
      operationId: "op2",
      operation: "ingest",
    });
    expect(second.committed).toBe(false);
    expect(second.sha).toBeNull();
    expect(second.reason).toContain("nothing to commit");
  });

  it("rejects paths outside the wiki root", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "wiki"), { recursive: true });
    await ensureGitRepo(root, "chore: wotw init");
    const insideFile = join(root, "wiki", "alpha.md");
    writeFileSync(insideFile, "a");
    const outsideFile = join(tmpRoot(), "outside.md");
    writeFileSync(outsideFile, "b");
    const result = await commitWikiChanges({
      wikiRoot: root,
      paths: [outsideFile, insideFile],
      operationId: "op1",
      operation: "ingest",
    });
    // Only the inside file should be staged.
    expect(result.committed).toBe(true);
    expect(result.fileCount).toBe(1);
  });
});
