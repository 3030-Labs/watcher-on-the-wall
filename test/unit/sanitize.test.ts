/**
 * Unit tests for the content sanitizer. The bulk of the redaction rules
 * are covered by regex round-trip tests; the most important of these is
 * the `password-in-url` rule, which must:
 *
 *   - redact `https://user:pass@host` → `https://user:[REDACTED]@host`
 *   - NOT touch bare `user@example.com` addresses
 *   - NOT touch `mailto:user@host` URIs (no password component)
 *
 * The audit finding L-SEC-3 flagged the risk of over-matching bare
 * `user@host` patterns; these tests lock the behavior in place.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_REDACTIONS, sanitize, sanitizeWithReport } from "../../src/utils/sanitize.js";

describe("sanitize — password-in-url (L-SEC-3 regression)", () => {
  it("redacts http(s) URLs with a user:password@host component", () => {
    const input = "curl https://alice:s3cret@example.com/api/x";
    const output = sanitize(input);
    expect(output).toBe("curl https://alice:[REDACTED]@example.com/api/x");
  });

  it("redacts non-http schemes with user:password@host too", () => {
    const input = "postgres://dbuser:hunter2@db.example.com:5432/wotw";
    const output = sanitize(input);
    expect(output).toContain("postgres://dbuser:[REDACTED]@db.example.com");
    expect(output).not.toContain("hunter2");
  });

  it("does NOT touch bare email addresses", () => {
    const input = "Contact us at jordan@example.com or ops@example.org.";
    const output = sanitize(input);
    expect(output).toBe(input);
  });

  it("does NOT touch mailto: URIs (no password component)", () => {
    const input = "Email link: mailto:jordan@example.com";
    const output = sanitize(input);
    expect(output).toBe(input);
  });

  it("does not trigger the rule when reporting on email-only text", () => {
    const { triggered } = sanitizeWithReport("Email jordan@example.com");
    expect(triggered).not.toContain("password-in-url");
  });

  it("reports the rule trigger when a real URL password is present", () => {
    const { output, triggered } = sanitizeWithReport("creds: ftp://svc:p%40ss@files.example.com/");
    expect(triggered).toContain("password-in-url");
    expect(output).toContain("ftp://svc:[REDACTED]@files.example.com/");
  });
});

describe("sanitize — DEFAULT_REDACTIONS shape", () => {
  it("includes password-in-url among the default rules", () => {
    const names = DEFAULT_REDACTIONS.map((r) => r.name);
    expect(names).toContain("password-in-url");
  });
});
