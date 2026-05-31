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
  /**
   * Cloud-side rule_id this rule maps to in the PASS-024 `redaction_log`
   * whitelist (`credential_pattern_01..10` + `truncation_32kb`). When set,
   * sanitizeWithEvents() emits a row tagged with this id. When omitted,
   * the redaction still fires but no outbound event is recorded — used
   * for PII rules (credit-card, us-ssn) that stay daemon-local per the
   * cloud's explicit whitelist (FEATURE-PASS-011 rule mapping).
   */
  cloud_rule_id?: string;
}

/**
 * Default redaction rules. Ordered by likely-to-match first for efficiency.
 */
export const DEFAULT_REDACTIONS: readonly RedactionRule[] = [
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:AWS_ACCESS_KEY]",
    cloud_rule_id: "credential_pattern_01",
  },
  {
    name: "aws-secret-key",
    pattern: /\b[A-Za-z0-9/+=]{40}\b(?=.*(?:secret|aws))/gi,
    replacement: "[REDACTED:AWS_SECRET_KEY]",
    cloud_rule_id: "credential_pattern_02",
  },
  {
    name: "github-token",
    // Review item 2: also catch GitHub fine-grained personal access
    // tokens (`github_pat_*`, 82+ chars per docs).
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/g,
    replacement: "[REDACTED:GITHUB_TOKEN]",
    cloud_rule_id: "credential_pattern_03",
  },
  {
    name: "anthropic-api-key",
    // Anthropic keys span ~95-115 chars after `sk-ant-`. The 80,120
    // window stays generous enough to catch both legacy and current
    // formats including api03- prefix.
    pattern: /\bsk-ant-[A-Za-z0-9-_]{80,120}\b/g,
    replacement: "[REDACTED:ANTHROPIC_API_KEY]",
    cloud_rule_id: "credential_pattern_04",
  },
  {
    name: "openai-api-key",
    // Review item 2: original `\bsk-[A-Za-z0-9]{20,}\b` missed modern
    // formats with `-` and `_` in the body — `sk-proj-*`,
    // `sk-svcacct-*`, `sk-admin-*` all use `-` separators after the
    // prefix and longer character set. Updated character class.
    pattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,200}\b|\bsk-[A-Za-z0-9]{20,200}\b/g,
    replacement: "[REDACTED:OPENAI_API_KEY]",
    cloud_rule_id: "credential_pattern_05",
  },
  {
    name: "gemini-api-key",
    // Review item 2: Google AI Studio API keys are `AIza` + 35 chars.
    // No rule existed pre-fix.
    pattern: /\bAIza[A-Za-z0-9_-]{35}\b/g,
    replacement: "[REDACTED:GEMINI_API_KEY]",
    cloud_rule_id: "credential_pattern_06",
  },
  {
    name: "wotw-daemon-token",
    // Review item 2: daemon tokens emitted by `wotw user add` are
    // `wotw_` + base64url chars. Pre-fix these went unredacted.
    pattern: /\bwotw_[A-Za-z0-9_-]{30,200}\b/g,
    replacement: "[REDACTED:WOTW_TOKEN]",
    cloud_rule_id: "credential_pattern_07",
  },
  {
    name: "private-key-block",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:PRIVATE_KEY_BLOCK]",
    cloud_rule_id: "credential_pattern_08",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
    replacement: "[REDACTED:JWT]",
    cloud_rule_id: "credential_pattern_09",
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
    cloud_rule_id: "credential_pattern_10",
  },
  {
    // PII — stays daemon-local. cloud_rule_id intentionally omitted: the
    // PASS-024 cloud whitelist accepts only credential_pattern_01..10 +
    // truncation_32kb, treating PII metadata as data-that-shouldn't-leave-
    // the-daemon. Redaction still fires on-disk; sink emission is skipped.
    name: "credit-card",
    pattern: /\b(?:\d[ -]*?){13,16}\b/g,
    replacement: "[REDACTED:PAN]",
  },
  {
    // PII — see credit-card note above.
    name: "us-ssn",
    pattern: /\b\d{3}-\d{2}-\d{4}\b/g,
    replacement: "[REDACTED:SSN]",
  },
];

/**
 * One captured redaction occurrence — the shape consumed by the
 * RedactionEmitStore. byte_count is the UTF-8 byte length of the
 * material that was replaced (sum across all matches of the rule in
 * one pass over the input).
 */
export interface RedactionEvent {
  rule_name: string;
  cloud_rule_id: string;
  byte_count: number;
}

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

/**
 * Redact + capture per-rule byte counts as RedactionEvents.
 *
 * Rules without a `cloud_rule_id` (PII: credit-card, us-ssn) still apply
 * their redaction but are NOT included in the events array — the cloud
 * whitelist treats those as data-that-shouldn't-leave-the-daemon.
 *
 * byte_count semantics: for each match of a rule's pattern, we add the
 * UTF-8 byte length of the matched substring. This is the size of the
 * material that *was* removed — useful for compliance auditors to see
 * redaction volume per rule per source file.
 *
 * Used by `src/ingestion/prompt-builder.ts` to feed the
 * `pending_redaction_emits` SQLite queue. See FEATURE-PASS-011.
 */
export function sanitizeWithEvents(
  input: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTIONS,
): { output: string; events: RedactionEvent[] } {
  const events: RedactionEvent[] = [];
  let out = input;
  for (const rule of rules) {
    // Reset lastIndex defensively — global regexes are stateful across
    // matchAll/test/exec calls and this code shares the DEFAULT_REDACTIONS
    // instance with sanitize()/sanitizeWithReport().
    rule.pattern.lastIndex = 0;
    let matchedBytes = 0;
    for (const m of out.matchAll(rule.pattern)) {
      matchedBytes += Buffer.byteLength(m[0], "utf8");
    }
    if (matchedBytes === 0) continue;
    rule.pattern.lastIndex = 0;
    out = out.replace(rule.pattern, rule.replacement);
    if (rule.cloud_rule_id) {
      events.push({
        rule_name: rule.name,
        cloud_rule_id: rule.cloud_rule_id,
        byte_count: matchedBytes,
      });
    }
  }
  return { output: out, events };
}
