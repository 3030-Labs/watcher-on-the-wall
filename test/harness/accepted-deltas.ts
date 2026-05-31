/**
 * Accepted-delta policy — Phase 3.
 *
 * Phase A documented three single-pass behaviors as KNOWN-ACCEPTED deltas vs the
 * multi-turn baseline. The regression harness must NOT flag characterized
 * single-pass behavior as a regression. Rather than suppress flags AFTER the
 * fact (which would let real drops hide behind a delta label), we NORMALIZE both
 * gold and extracted facts so an accepted delta never produces a miss in the
 * first place — the structural fix, not the theatrical one.
 *
 * The three deltas, mapped into fact-level scoring:
 *   1. Hallucinated `created:` date — FRONTMATTER-scoped. Fact statements
 *      (entity + claim) do not carry the wiki page's `created` date, so this
 *      delta is N/A to fact scoring. We still strip stray ISO timestamps that
 *      could leak into a statement so a clock artifact never counts as content.
 *   2. Page consolidation — single-pass consolidates granular pages (e.g.
 *      c3/c4/cam-plants -> one page). Entity granularity must not cause a miss:
 *      handled by per-fixture `aliases` + entity normalization.
 *   3. Backlink-path drift — `./x.md` vs `wiki/concepts/x.md`. Link PATHS inside
 *      statements are stripped to their final slug so a path style never counts.
 */

/** Strip markdown/wiki link paths to their final slug; drop ISO timestamps. */
export function stripAcceptedDeltaArtifacts(text: string): string {
  return (
    text
      // wiki-rooted or relative markdown link target -> final slug
      // e.g. "./light-dependent-reactions.md" / "wiki/concepts/x.md" -> "x"
      .replace(/(?:\.{0,2}\/)?(?:[\w-]+\/)*([\w-]+)\.md/g, "$1")
      // ISO-8601 timestamps / yyyy-mm-dd date artifacts (clock leakage)
      .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?\b/g, " ")
  );
}

/** English stopwords excluded from content-token comparison. */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "the",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "and",
  "or",
  "but",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "as",
  "that",
  "this",
  "these",
  "those",
  "it",
  "its",
  "from",
  "into",
  "than",
  "then",
  "also",
  "which",
  "who",
  "whom",
  "whose",
  "they",
  "them",
  "their",
  "have",
  "has",
  "had",
  "can",
  "could",
  "would",
  "should",
  "may",
  "might",
  "will",
  "shall",
  "do",
  "does",
  "did",
  "not",
  "no",
  "called",
  "known",
  "most",
  "some",
  "such",
  "about",
]);
