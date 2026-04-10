/**
 * Content sanitization: strip credentials and PII patterns from text before LLM ingestion.
 *
 * This is a best-effort redaction layer. Users can extend the patterns list via
 * configuration. The goal is to keep secrets out of logs, prompts, and wiki pages.
 */

export interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: string;
}

/**
 * Default redaction rules. Ordered by likely-to-match first for efficiency.
 */
export const DEFAULT_REDACTIONS: readonly RedactionRule[] = [
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:AWS_ACCESS_KEY]",
  },
  {
    name: "aws-secret-key",
    pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*(?:secret|aws))/gi,
    replacement: "[REDACTED:AWS_SECRET_KEY]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    replacement: "[REDACTED:GITHUB_TOKEN]",
  },
  {
    name: "anthropic-api-key",
    pattern: /\bsk-ant-[A-Za-z0-9-_]{80,120}\b/g,
    replacement: "[REDACTED:ANTHROPIC_API_KEY]",
  },
  {
    name: "openai-api-key",
    pattern: /\bsk-[A-Za-z0-9]{20,}\b/g,
    replacement: "[REDACTED:OPENAI_API_KEY]",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY_BLOCK]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED:JWT]",
  },
  {
    // L-SEC-3: This pattern is deliberately scoped to full `scheme://`
    // URIs with a `user:password@` userinfo component. The `\w+:\/\/`
    // prefix is load-bearing — without it the pattern would also match
    // bare `user@host` email addresses and `mailto:user@host` URIs,
    // both of which carry no password and must not be over-redacted.
    // Verified by unit tests in test/unit/sanitize.test.ts.
    name: "password-in-url",
    pattern: /(\w+:\/\/[^:/\s]+:)[^@\s]+(@)/g,
    replacement: "$1[REDACTED]$2",
  },
  {
    name: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    replacement: "[REDACTED:PAN]",
  },
  {
    name: "us-ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[REDACTED:SSN]",
  },
];

/**
 * Redact sensitive content from a text blob using the supplied rules (or defaults).
 */
export function sanitize(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTIONS,
): string {
  let out = input;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement);
  }
  return out;
}

/**
 * Redact and return the list of rule names that triggered.
 */
export function sanitizeWithReport(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTIONS,
): { output: string; triggered: string[] } {
  const triggered: string[] = [];
  let out = input;
  for (const rule of rules) {
    if (rule.pattern.test(out)) {
      triggered.push(rule.name);
      // Reset lastIndex for global regexes before replacing
      rule.pattern.lastIndex = 0;
      out = out.replace(rule.pattern, rule.replacement);
    }
  }
  return { output: out, triggered };
}
