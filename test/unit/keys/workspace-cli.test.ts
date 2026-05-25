/**
 * Unit tests for the `wotw workspace` CLI command parsing
 * (PASS-019 Part B). Exercises the registration without actually
 * triggering any DB operations — we mock the action paths and
 * confirm the Commander wiring is right.
 */
import { describe, expect, it } from "vitest";
import { Command } from "commander";
import { registerWorkspaceCommand } from "../../../src/cli/commands/workspace.js";

describe("registerWorkspaceCommand", () => {
  it("registers the workspace command with rotate-kek + archive-overlapped subcommands", () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspaceCommand(program);
    const workspaceCmd = program.commands.find((c) => c.name() === "workspace");
    expect(workspaceCmd).toBeDefined();
    const subcommands = workspaceCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain("rotate-kek");
    expect(subcommands).toContain("archive-overlapped");
  });

  it("rotate-kek subcommand exposes --confirm flag", () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspaceCommand(program);
    const workspaceCmd = program.commands.find((c) => c.name() === "workspace");
    const rotateKek = workspaceCmd!.commands.find((c) => c.name() === "rotate-kek");
    expect(rotateKek).toBeDefined();
    const flags = rotateKek!.options.map((o) => o.long);
    expect(flags).toContain("--confirm");
    expect(flags).toContain("--json");
  });

  it("archive-overlapped subcommand exposes --overlap-hours flag", () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspaceCommand(program);
    const workspaceCmd = program.commands.find((c) => c.name() === "workspace");
    const archiveCmd = workspaceCmd!.commands.find((c) => c.name() === "archive-overlapped");
    expect(archiveCmd).toBeDefined();
    const flags = archiveCmd!.options.map((o) => o.long);
    expect(flags).toContain("--overlap-hours");
    expect(flags).toContain("--json");
  });

  it("the workspace help text mentions G5 attestation substrate", () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspaceCommand(program);
    const workspaceCmd = program.commands.find((c) => c.name() === "workspace");
    expect(workspaceCmd!.description()).toMatch(/G5/i);
  });

  it("rotate-kek help text references WOTW_WORKSPACE_KEK_NEW", () => {
    const program = new Command();
    program.exitOverride();
    registerWorkspaceCommand(program);
    const workspaceCmd = program.commands.find((c) => c.name() === "workspace");
    const rotateKek = workspaceCmd!.commands.find((c) => c.name() === "rotate-kek");
    expect(rotateKek!.description()).toMatch(/WOTW_WORKSPACE_KEK_NEW/);
  });
});
