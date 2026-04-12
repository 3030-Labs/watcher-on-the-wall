import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";
import { VERSION } from "../../src/utils/version.js";

const require = createRequire(import.meta.url);
const pkg = require("../../package.json") as { version: string };

describe("VERSION utility", () => {
  it("matches package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("looks like a semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
