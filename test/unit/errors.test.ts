/**
 * Tests for the errMsg utility.
 */
import { describe, expect, it } from "vitest";
import { errMsg } from "../../src/utils/errors.js";

describe("errMsg", () => {
  it("extracts message from Error instance", () => {
    expect(errMsg(new Error("test error"))).toBe("test error");
  });

  it("converts string to itself", () => {
    expect(errMsg("raw string")).toBe("raw string");
  });

  it("converts null to 'null'", () => {
    expect(errMsg(null)).toBe("null");
  });

  it("converts undefined to 'undefined'", () => {
    expect(errMsg(undefined)).toBe("undefined");
  });

  it("converts object to string representation", () => {
    expect(errMsg({ code: 42 })).toBe("[object Object]");
  });

  it("converts number to string", () => {
    expect(errMsg(42)).toBe("42");
  });
});
