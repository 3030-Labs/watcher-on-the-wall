/**
 * Text-truncation utilities for context-efficient retrieval.
 *
 * The progressive-retrieval and narrow-query MCP tools (Feature Pass 005-007)
 * ship the smallest viable payload first and expand only on signal from the
 * client LLM. To do that without burning the caller's budget on a hard
 * mid-word cut, every payload boundary cuts on a *sentence boundary* (or, as
 * a fallback, a word boundary). Mid-token cuts are not allowed.
 *
 * The token budget is expressed in tokens, but truncation itself works in
 * characters — we convert at the boundary using a 4-chars-per-token heuristic
 * that matches the daemon's existing CLI-mode approximation (see
 * `src/ingestion/cli-invoker.ts:206`). Providers that need exact counts go
 * through `src/server/token-estimator.ts` and validate at the response edge.
 *
 * Design notes:
 *   - We don't depend on a specific tokenizer here. Truncation produces
 *     "safe" payloads bounded by char-equivalent budgets; the token-estimator
 *     re-counts on the way out for precise reporting.
 *   - Sentence-boundary search looks back up to LOOKBACK_RATIO of the budget
 *     so the cut lands on a punctuation/whitespace, not mid-word.
 *   - Markdown outline extraction strips YAML frontmatter and returns the
 *     header skeleton so the client LLM can pick which section to expand.
 */

/** Sentence-terminating punctuation. Excludes ellipses (handled separately). */
const SENTENCE_TERMINATORS = new Set([".", "!", "?"]);

/**
 * Fraction of the budget the lookback window may scan for a sentence
 * boundary. Tuned to 30% so the algorithm can reach a terminator that
 * sits just before the hard char cap without dropping the entire last
 * sentence.
 */
const LOOKBACK_RATIO = 0.3;

/** Characters per token under the 4-char heuristic. */
export const CHARS_PER_TOKEN = 4;

/** Convert a token budget into a character budget. */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

/** Convert a character count into an approximate token count. */
export function charsToTokens(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Truncate `text` to fit within `maxTokens` (4-chars-per-token heuristic),
 * preferring a cut on a sentence boundary. Falls back to a word boundary if
 * no sentence boundary is found within the lookback window. Returns the
 * original text unchanged when it already fits.
 */
export function truncateToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || text.length === 0) return "";
  const maxChars = tokensToChars(maxTokens);
  if (text.length <= maxChars) return text;

  const slice = text.slice(0, maxChars);
  const lookBack = Math.max(0, Math.floor(maxChars * LOOKBACK_RATIO));
  const minIdx = Math.max(0, maxChars - lookBack);

  // First pass: sentence boundary (punct followed by whitespace or eof).
  for (let i = slice.length - 1; i >= minIdx; i--) {
    const c = slice[i];
    if (c === undefined) continue;
    if (SENTENCE_TERMINATORS.has(c)) {
      const next = text[i + 1];
      if (next === undefined || /\s/.test(next)) {
        return slice.slice(0, i + 1);
      }
    }
  }

  // Second pass: word boundary (whitespace).
  for (let i = slice.length - 1; i >= minIdx; i--) {
    const c = slice[i];
    if (c !== undefined && /\s/.test(c)) {
      return slice.slice(0, i).trimEnd();
    }
  }

  // No boundary found — hard cut at maxChars.
  return slice;
}

/** One header in a markdown outline. */
export interface OutlineEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  /** Slug derived from the header (lowercase, hyphenated). */
  slug: string;
  /** Character offset in the body where this section starts. */
  offset: number;
}

/**
 * Strip a YAML frontmatter block (`---\n...\n---\n`) from the head of a
 * markdown document. Returns `{ frontmatter, body }`. If no frontmatter is
 * present, frontmatter is the empty string and body is the original input.
 */
export function splitFrontmatter(markdown: string): { frontmatter: string; body: string } {
  if (!markdown.startsWith("---")) return { frontmatter: "", body: markdown };
  const rest = markdown.slice(3);
  // Match a closing --- at the start of a line.
  const closeIdx = rest.indexOf("\n---");
  if (closeIdx === -1) return { frontmatter: "", body: markdown };
  const afterClose = closeIdx + 4; // skip "\n---"
  // Skip the rest of the closing line.
  let bodyStart = afterClose;
  while (bodyStart < rest.length && rest[bodyStart] !== "\n") bodyStart++;
  if (bodyStart < rest.length && rest[bodyStart] === "\n") bodyStart++;
  return {
    frontmatter: rest.slice(0, closeIdx),
    body: rest.slice(bodyStart),
  };
}

/** Render an outline entry as a single bullet line for inclusion in prompts. */
export function renderOutlineEntry(entry: OutlineEntry): string {
  const indent = "  ".repeat(Math.max(0, entry.level - 1));
  return `${indent}- ${entry.title}`;
}

/**
 * Extract the header outline from a markdown body. Skips fenced code blocks
 * (a "## " inside a ```...``` fence is not a header). Frontmatter is
 * dropped before scanning.
 */
export function extractOutline(markdown: string): OutlineEntry[] {
  const { body } = splitFrontmatter(markdown);
  const out: OutlineEntry[] = [];
  let inFence = false;
  let offset = 0;
  for (const line of body.split("\n")) {
    const lineLen = line.length + 1; // +1 for the newline we split on
    if (line.startsWith("```")) {
      inFence = !inFence;
      offset += lineLen;
      continue;
    }
    if (!inFence) {
      const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (m && m[1] && m[2]) {
        const level = m[1].length as 1 | 2 | 3 | 4 | 5 | 6;
        const title = m[2].trim();
        out.push({ level, title, slug: slugify(title), offset });
      }
    }
    offset += lineLen;
  }
  return out;
}

/**
 * Slugify a header title (lowercase, hyphen-separated, alphanumeric only).
 * Used to generate stable section identifiers for later structured fetches.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** One section's lede paragraph alongside its header info. */
export interface SectionLede {
  header: OutlineEntry | null;
  /** First non-empty paragraph after the header. Trimmed. */
  lede: string;
}

/**
 * Extract the outline plus the first paragraph after each header. Used by
 * tier-2 progressive expansion: "show me each section, just the lede." Pages
 * with no headers fall back to a single SectionLede whose header is null and
 * whose lede is the page's first paragraph.
 */
export function extractSectionLedes(markdown: string): SectionLede[] {
  const { body } = splitFrontmatter(markdown);
  const headers = extractOutline(markdown);
  if (headers.length === 0) {
    const lede = firstParagraph(body);
    return lede ? [{ header: null, lede }] : [];
  }
  const sections: SectionLede[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const nextOffset = i + 1 < headers.length ? headers[i + 1]!.offset : body.length;
    // Find where the header line ends (its newline) — sections start after that.
    const headerLineEnd = body.indexOf("\n", h.offset);
    const sectionStart = headerLineEnd === -1 ? h.offset : headerLineEnd + 1;
    const sectionBody = body.slice(sectionStart, nextOffset);
    const lede = firstParagraph(sectionBody);
    if (lede) sections.push({ header: h, lede });
  }
  return sections;
}

/**
 * Find the first non-empty paragraph in `text`. Paragraphs are separated by
 * blank lines. Returns the empty string if no paragraph is found.
 */
export function firstParagraph(text: string): string {
  const lines = text.split("\n");
  const current: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") {
      if (current.length > 0) return current.join("\n").trim();
      continue;
    }
    current.push(line);
  }
  return current.join("\n").trim();
}

/**
 * Split a block of text into sentences. Conservative regex — matches on
 * `[.!?]` followed by whitespace or end-of-text. Doesn't try to be clever
 * about abbreviations (Mr., e.g.) because the consumers below tolerate
 * over-splitting. Trims results.
 */
export function sentenceSplit(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  // Match runs ending in . ! or ? followed by whitespace or end.
  const matches = trimmed.match(/[^.!?]+[.!?]+(?=\s|$)|[^.!?]+$/g);
  if (!matches) return [trimmed];
  return matches.map((m) => m.trim()).filter((s) => s.length > 0);
}

/**
 * Return sentences from `text` that contain *all* of the supplied anchor
 * substrings (case-insensitive), up to `maxTokens` worth of total text.
 * Stops at the first sentence that would exceed the budget.
 */
export function extractSentencesContainingAll(
  text: string,
  anchors: string[],
  maxTokens: number,
): string[] {
  if (anchors.length === 0) return [];
  const lowered = anchors.map((a) => a.toLowerCase());
  const budget = tokensToChars(maxTokens);
  const out: string[] = [];
  let used = 0;
  for (const sentence of sentenceSplit(text)) {
    const lc = sentence.toLowerCase();
    if (lowered.every((a) => lc.includes(a))) {
      if (used + sentence.length > budget) break;
      out.push(sentence);
      used += sentence.length + 1; // +1 for the space we'd join on
    }
  }
  return out;
}
