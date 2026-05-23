/**
 * Build prompts handed to the ingestion LLM. The ingestion pipeline uses the
 * Claude Agent SDK to let the model do its own reading/writing of wiki files,
 * but the *initial* user turn still needs a carefully crafted brief that
 * tells the model:
 *
 *   1. What files were just dropped and where they live
 *   2. The wiki layout and CLAUDE.md conventions
 *   3. What's expected on success (one or more markdown files under
 *      `wiki/<category>/`), and what to avoid
 *
 * The builder returns a structured object so the llm-invoker can attach it
 * to a session and the cost-tracker can hash the prompt for provenance.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNullAsync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import { sanitize } from "../utils/sanitize.js";
import type { WotwConfig } from "../utils/types.js";
import { parsePage } from "../wiki/page.js";

export interface IngestionPrompt {
  /** The full user-turn body. */
  text: string;
  /** Sanitized excerpts of each source file in the order they were read. */
  excerpts: { path: string; excerpt: string; bytes: number; truncated: boolean }[];
  /** The system prompt (currently our CLAUDE.md instructions). */
  system: string;
}

const MAX_EXCERPT_BYTES = 32 * 1024; // 32KB per file in the prompt
const CLAUDE_MD_MAX_BYTES = 64 * 1024;

export interface ExistingPageManifestEntry {
  path: string;
  title: string;
  category: string;
  tags?: string[];
  status?: string | null;
}

export interface BuildIngestionPromptOptions {
  config: WotwConfig;
  files: string[];
  claudeMdOverride?: string;
  /** Optional override for testing — otherwise read from disk. */
  readFile?: (path: string) => string;
  /**
   * Review item 17: slim manifest of existing wiki pages so the model
   * can dedupe / merge / supersede / match conventions. Caller loads
   * via WikiStore.listAll() and projects to the shape above. When the
   * manifest exceeds {@link EXISTING_PAGES_FULL_LIST_LIMIT}, the top
   * {@link EXISTING_PAGES_PROMPT_CAP} by token-overlap with incoming
   * sources are kept (X1-C1 scope-bound).
   */
  existingPages?: ExistingPageManifestEntry[];
}

/** Cap for the manifest section in the prompt (per X1-C1). */
export const EXISTING_PAGES_PROMPT_CAP = 50;
/** Wiki size above which we pick the most-relevant pages instead of full list. */
export const EXISTING_PAGES_FULL_LIST_LIMIT = 200;

/**
 * Build the ingestion prompt for a batch of files.
 */
export async function buildIngestionPrompt(
  opts: BuildIngestionPromptOptions,
): Promise<IngestionPrompt> {
  const read = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));

  const excerpts: IngestionPrompt["excerpts"] = [];
  for (const file of opts.files) {
    try {
      const raw = read(file);
      // Review item 18: byte-correct truncation. Pre-fix used string
      // length (UTF-16 code units), which mis-measured multilingual
      // content (CJK = 1 code unit but 3-4 bytes; emoji = surrogate pair).
      // Slice on a UTF-8 byte boundary by buffering first.
      const rawBytes = Buffer.byteLength(raw, "utf8");
      const truncated = rawBytes > MAX_EXCERPT_BYTES;
      let body: string;
      if (truncated) {
        const buf = Buffer.from(raw, "utf8").subarray(0, MAX_EXCERPT_BYTES);
        body = `${buf.toString("utf8")}\n\n...[truncated]`;
        // Review item 18: emit a structured log when truncation fires so
        // the operator can see context loss instead of silently losing it.
        getLogger("prompt-builder").warn(
          { path: file, rawBytes, capBytes: MAX_EXCERPT_BYTES },
          "source file truncated for prompt — model sees only the first MAX_EXCERPT_BYTES",
        );
      } else {
        body = raw;
      }
      excerpts.push({
        path: file,
        excerpt: sanitize(body),
        bytes: rawBytes,
        truncated,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger("prompt-builder").warn({ path: file, err: msg }, "skipping unreadable source file");
      continue;
    }
  }

  // Gather rejection feedback from previously rejected candidates.
  const rejections = loadRejectionFeedback(opts.config);

  // Review item 17: select existing-page manifest to surface to the model.
  const manifest = selectRelevantPages(opts.existingPages ?? [], excerpts);

  const system = opts.claudeMdOverride ?? (await loadClaudeMd(opts.config));
  const text = renderUserTurn(opts.config, excerpts, rejections, manifest);

  return { text, excerpts, system };
}

/**
 * Pick the slice of the wiki's existing pages to surface to the model.
 * If the wiki is small enough, dump the whole list. Otherwise rank by
 * token-overlap with incoming source excerpts (cheap word-set jaccard)
 * and keep the top {@link EXISTING_PAGES_PROMPT_CAP}.
 */
function selectRelevantPages(
  manifest: ExistingPageManifestEntry[],
  excerpts: IngestionPrompt["excerpts"],
): ExistingPageManifestEntry[] {
  if (manifest.length === 0) return [];
  if (manifest.length <= EXISTING_PAGES_FULL_LIST_LIMIT) return manifest;

  const sourceTokens = new Set<string>();
  for (const e of excerpts) {
    for (const tok of tokenize(e.excerpt)) sourceTokens.add(tok);
  }
  const scored = manifest.map((p) => {
    const pageTokens = new Set([
      ...tokenize(p.title),
      ...(p.tags ?? []).flatMap((t) => tokenize(t)),
    ]);
    let overlap = 0;
    for (const t of pageTokens) {
      if (sourceTokens.has(t)) overlap += 1;
    }
    return { p, score: overlap };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, EXISTING_PAGES_PROMPT_CAP).map((s) => s.p);
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

async function loadClaudeMd(cfg: WotwConfig): Promise<string> {
  const path = join(cfg.wiki_root, "CLAUDE.md");
  const contents = await readTextOrNullAsync(path);
  if (!contents) return DEFAULT_SYSTEM;
  // Review item 19: byte-correct truncation + structured log when the
  // operator's main lever against context-loss is silently capped.
  const rawBytes = Buffer.byteLength(contents, "utf8");
  if (rawBytes <= CLAUDE_MD_MAX_BYTES) return contents;
  const buf = Buffer.from(contents, "utf8").subarray(0, CLAUDE_MD_MAX_BYTES);
  getLogger("prompt-builder").warn(
    { path, rawBytes, capBytes: CLAUDE_MD_MAX_BYTES },
    "CLAUDE.md truncated for prompt — model sees only the first CLAUDE_MD_MAX_BYTES",
  );
  return buf.toString("utf8");
}

const DEFAULT_SYSTEM = `You are the watcher-on-the-wall ingestion agent.
Your job is to read source files dropped into the raw/ directory and
produce interlinked wiki pages under wiki/<category>/.

Categories: concept, entity, source, comparison, synthesis, query.

Each wiki page MUST begin with YAML frontmatter:
  title: string
  category: concept|entity|source|comparison|synthesis|query
  created: YYYY-MM-DD
  updated: YYYY-MM-DD
  sources: [list of raw/ paths]
  related: [list of wiki/ slugs]
  tags: [strings]
  confidence: high|medium|low

For every wiki page you write, also include these optional frontmatter fields:
  - domain: a broad knowledge domain category (e.g., ops, security, architecture, research, finance, engineering)
  - scope: the project or organizational context this knowledge belongs to (e.g., the project name, team name, or "general")
  - key_terms: an array of 5-15 keywords and phrases that this page should be findable by, including synonyms and alternative phrasings not used in the body text

Rules:
  - Always produce at least one source-category page per raw file.
  - Always link related concepts bidirectionally.
  - Never modify files in raw/.
  - Never emit placeholder TODOs — write what you know.`;

interface RejectionFeedback {
  title: string;
  reason: string;
}

/**
 * Scan the rejected candidates directory for rejection reasons.
 * These feed back into the LLM prompt so the model learns from past rejections.
 */
function loadRejectionFeedback(config: WotwConfig): RejectionFeedback[] {
  const rejectedDir = join(config.wiki_root, "candidates", "rejected");
  let files: string[];
  try {
    files = readdirSync(rejectedDir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const feedback: RejectionFeedback[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(rejectedDir, file), "utf8");
      const page = parsePage(join(rejectedDir, file), raw);
      if (page.frontmatter.rejection_note) {
        feedback.push({
          title: page.frontmatter.title,
          reason: page.frontmatter.rejection_note,
        });
      }
    } catch {
      // Skip unreadable rejected pages.
    }
  }
  return feedback;
}

function renderUserTurn(
  cfg: WotwConfig,
  excerpts: IngestionPrompt["excerpts"],
  rejections: RejectionFeedback[] = [],
  existingPages: ExistingPageManifestEntry[] = [],
): string {
  const lines: string[] = [];
  lines.push("# Ingestion batch");
  lines.push("");
  lines.push(`Wiki root: ${cfg.wiki_root}`);
  lines.push(`Raw path: ${cfg.raw_path}`);
  lines.push("");
  lines.push(`You have ${excerpts.length} source file(s) to ingest. For each file,`);
  lines.push("produce or update a `source` page under `wiki/sources/`, and create or");
  lines.push("link any `concept` / `entity` pages the material references.");
  lines.push("");
  lines.push("## Source files");
  for (const e of excerpts) {
    lines.push("");
    lines.push(`### ${e.path}`);
    lines.push(`- bytes: ${e.bytes}${e.truncated ? " (truncated)" : ""}`);
    lines.push("");
    lines.push("```");
    lines.push(e.excerpt);
    lines.push("```");
  }
  lines.push("");
  // Review item 17: surface existing wiki pages so the model can dedupe,
  // merge, supersede, and match category conventions.
  if (existingPages.length > 0) {
    lines.push("## Existing wiki pages");
    lines.push("");
    lines.push(
      `The wiki already contains the following pages (${existingPages.length} shown). ` +
        "Prefer updating an existing page over creating a new one with overlapping " +
        "content; cross-link via `related:` rather than duplicating; use " +
        "`status: superseded_by:` to chain successors.",
    );
    lines.push("");
    for (const p of existingPages) {
      const tagSuffix =
        p.tags && p.tags.length > 0 ? ` — tags: ${p.tags.slice(0, 6).join(", ")}` : "";
      const statusSuffix =
        p.status && p.status !== "active" && p.status !== null ? ` [${p.status}]` : "";
      lines.push(`- \`${p.path}\` (${p.category}) — ${p.title}${tagSuffix}${statusSuffix}`);
    }
    lines.push("");
  }

  // Rejection feedback from previously rejected candidates.
  if (rejections.length > 0) {
    lines.push("## Previous rejections");
    lines.push("");
    lines.push("The following pages were rejected by the user. Learn from their feedback:");
    lines.push("");
    for (const r of rejections) {
      lines.push(`- **${r.title}**: ${r.reason}`);
    }
    lines.push("");
  }

  lines.push("## Expected output");
  lines.push("");
  lines.push("Return ONLY valid JSON with this shape, no other text:");
  lines.push("");
  lines.push("```json");
  lines.push("{");
  lines.push('  "edits": [');
  lines.push("    {");
  lines.push('      "path": "wiki/<category>/<slug>.md",');
  lines.push('      "content": "---\\nfull YAML frontmatter and markdown body\\n---\\n..."');
  lines.push("    }");
  lines.push("  ]");
  lines.push("}");
  lines.push("```");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Emit one edit per wiki page you want to create or update.");
  lines.push("- The `content` field is the COMPLETE file content including frontmatter.");
  lines.push(
    "- Every new page must include full YAML frontmatter (title, category, created, updated, sources, related, tags, confidence).",
  );
  lines.push("- Use `[[wiki-links]]` when referring to other pages.");
  lines.push(
    "- Cite source files in the `sources:` frontmatter list (relative paths under `raw/`).",
  );
  lines.push("- Always produce at least one source-category page per raw file.");
  lines.push("- Do NOT include any text outside the JSON object.");
  return lines.join("\n");
}
