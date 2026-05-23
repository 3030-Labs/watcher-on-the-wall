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

describe("sanitize — aws-access-key", () => {
  it("redacts an AWS access key ID", () => {
    const input = "key = AKIAIOSFODNN7EXAMPLE";
    const output = sanitize(input);
    expect(output).toBe("key = [REDACTED:AWS_ACCESS_KEY]");
    expect(output).not.toContain("AKIAIOSFODNN7EXAMPLE");
  });
});

describe("sanitize — aws-secret-key", () => {
  it("redacts an AWS secret access key when context word follows", () => {
    // The regex uses a lookahead (?=.*(?:secret|aws)) — the context word
    // must appear AFTER the key on the same line for the match to trigger.
    const secretKey = "wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEYab";
    expect(secretKey.length).toBe(40);
    const input = `${secretKey} aws_secret_access_key`;
    const output = sanitize(input);
    expect(output).toBe("[REDACTED:AWS_SECRET_KEY] aws_secret_access_key");
    expect(output).not.toContain(secretKey);
  });
});

describe("sanitize — github-token", () => {
  it("redacts a GitHub personal access token", () => {
    const token = "ghp_" + "A".repeat(36);
    const input = `GITHUB_TOKEN=${token}`;
    const output = sanitize(input);
    expect(output).toBe("GITHUB_TOKEN=[REDACTED:GITHUB_TOKEN]");
    expect(output).not.toContain(token);
  });
});

describe("sanitize — anthropic-api-key", () => {
  it("redacts an Anthropic API key", () => {
    const token = "sk-ant-" + "a".repeat(80);
    const input = `key: ${token}`;
    const output = sanitize(input);
    expect(output).toBe("key: [REDACTED:ANTHROPIC_API_KEY]");
    expect(output).not.toContain(token);
  });
});

describe("sanitize — openai-api-key", () => {
  it("redacts an OpenAI API key", () => {
    const token = "sk-" + "x".repeat(48);
    const input = `OPENAI_API_KEY=${token}`;
    const output = sanitize(input);
    expect(output).toBe("OPENAI_API_KEY=[REDACTED:OPENAI_API_KEY]");
    expect(output).not.toContain(token);
  });
});

describe("sanitize — private-key-block", () => {
  it("redacts a PEM private key block", () => {
    const input = `before\n-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALx...\n-----END RSA PRIVATE KEY-----\nafter`;
    const output = sanitize(input);
    expect(output).toBe("before\n[REDACTED:PRIVATE_KEY_BLOCK]\nafter");
    expect(output).not.toContain("MIIBogIBAAJBALx");
  });
});

describe("sanitize — jwt", () => {
  it("redacts a JWT token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dummysignature123";
    const input = `Authorization: Bearer ${jwt}`;
    const output = sanitize(input);
    expect(output).toContain("[REDACTED:JWT]");
    expect(output).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });
});

describe("sanitize — credit-card", () => {
  it("redacts a credit card number", () => {
    const input = "card: 4111111111111111";
    const output = sanitize(input);
    expect(output).toBe("card: [REDACTED:PAN]");
    expect(output).not.toContain("4111111111111111");
  });
});

describe("sanitize — DEFAULT_REDACTIONS shape", () => {
  it("includes password-in-url among the default rules", () => {
    const names = DEFAULT_REDACTIONS.map((r) => r.name);
    expect(names).toContain("password-in-url");
  });
});

describe("review item 2 — modern key formats", () => {
  it("redacts sk-proj-* (OpenAI project key)", () => {
    const input = "key: sk-proj-PKyb6DKLd7aJUa0eKCo0ru4C4MNQTfNZDWTALgXFy3ejKc44OD0LtBmFU";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:OPENAI_API_KEY]");
    expect(out).not.toContain("PKyb6DKLd7aJUa0eKCo0");
  });

  it("redacts sk-svcacct-* (OpenAI service account)", () => {
    const input = "key: sk-svcacct-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:OPENAI_API_KEY]");
  });

  it("redacts sk-admin-* (OpenAI admin)", () => {
    const input = "key: sk-admin-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:OPENAI_API_KEY]");
  });

  it("redacts AIza* (Google AI Studio / Gemini)", () => {
    const input = "key: AIzaSyCmjWiwXnlqAv3JEZRxxJlX3P1y1MbGB_o";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:GEMINI_API_KEY]");
    expect(out).not.toContain("AIzaSyCmjWiwXnlqAv3JEZRxxJlX3P1y1MbGB_o");
  });

  it("redacts github_pat_* (GitHub fine-grained PAT)", () => {
    const input =
      "token: github_pat_11ABCDEFG0AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEFGHIJKLMNOPQRSTUVWXY";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:GITHUB_TOKEN]");
  });

  it("redacts wotw_* daemon tokens", () => {
    const input = "auth: wotw_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_";
    const out = sanitize(input);
    expect(out).toContain("[REDACTED:WOTW_TOKEN]");
  });
});
