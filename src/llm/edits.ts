/**
 * Structured edits response shape used by the daemon's single-pass LLM
 * call sites. The model returns:
 *
 *   { "edits": [ { "path": "<wiki-relative-or-absolute>", "content": "..." } ] }
 *
 * The daemon parses this, sanitizes paths against `wiki_root`, and
 * applies each edit via `atomicWrite`. Phases 5 (heal-handlers) and
 * 6 (main ingestion + compounding hand-off) share this code path.
 *
 * Why a shared module: each call site that uses this shape (heal + main
 * ingestion + future compounding-with-edits) would otherwise re-implement
 * the same JSON extraction + path sanitization. Drift between them
 * would be a real bug surface — same problem we solved for chain-hash
 * via the vendored anchor pattern.
 */
import { isAbsolute, resolve } from "node:path";

/** A single file edit emitted by the model. */
export interface DaemonEdit {
  /** Wiki-relative or absolute path. */
  path: string;
  /** Full new file content (including frontmatter). */
  content: string;
}

/** Parsed response envelope. */
export interface DaemonEditsResponse {
  edits: DaemonEdit[];
}

/**
 * Parse the raw model response into a DaemonEditsResponse. The prompt
 * instructs the model to emit JSON-only; this parser is defensive:
 *
 *   - Strips a leading/trailing markdown code fence (```json ... ```)
 *     emitted by some providers (Gemini, Ollama) despite the prompt
 *     instruction.
 *   - Falls back to extracting the first balanced `{...}` block when
 *     the candidate has stray surrounding text.
 *   - Returns null if no JSON block found or JSON.parse throws.
 *   - Validates `edits` is an array; per-edit validates `path` and
 *     `content` are non-empty strings.
 *
 * Returns null on any failure — caller is expected to log + skip.
 */
export function parseDaemonEditsResponse(text: string): DaemonEditsResponse | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // Strip a wrapping markdown code fence. Gemini frequently emits
  // ```json\n{...}\n``` despite the prompt's JSON-only instruction.
  let candidate = trimmed;
  const fenceMatch = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fenceMatch && fenceMatch[1]) {
    candidate = fenceMatch[1].trim();
  }
  // Try direct parse first.
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    // Fall back to balanced-brace extraction for stray text.
    const match = candidate.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { edits?: unknown }).edits)
  ) {
    return null;
  }
  const raw = (parsed as { edits: unknown[] }).edits;
  const edits: DaemonEdit[] = [];
  for (const e of raw) {
    if (
      e &&
      typeof e === "object" &&
      typeof (e as DaemonEdit).path === "string" &&
      (e as DaemonEdit).path.length > 0 &&
      typeof (e as DaemonEdit).content === "string"
    ) {
      edits.push({
        path: (e as DaemonEdit).path,
        content: (e as DaemonEdit).content,
      });
    }
  }
  return { edits };
}

/**
 * Resolve an edit path (wiki-relative or absolute) to an absolute path
 * within `wikiRoot`. Rejects paths that escape via `..` or absolute
 * paths outside the wiki tree.
 *
 * Returns null on rejection — caller is expected to log + skip.
 */
export function resolveEditPath(wikiRoot: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  const candidate = isAbsolute(p) ? resolve(p) : resolve(wikiRoot, p);
  const root = resolve(wikiRoot);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    return null;
  }
  return candidate;
}
