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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readTextOrNullAsync } from "../utils/fs.js";
import { sanitize } from "../utils/sanitize.js";
import type { WotwConfig } from "../utils/types.js";

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

export interface BuildIngestionPromptOptions {
  config: WotwConfig;
  files: string[];
  claudeMdOverride?: string;
  /** Optional override for testing — otherwise read from disk. */
  readFile?: (path: string) => string;
}

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
      const truncated = raw.length > MAX_EXCERPT_BYTES;
      const body = truncated ? `${raw.slice(0, MAX_EXCERPT_BYTES)}\n\n...[truncated]` : raw;
      excerpts.push({
        path: file,
        excerpt: sanitize(body),
        bytes: Buffer.byteLength(raw, "utf8"),
        truncated,
      });
    } catch (err) {
      excerpts.push({
        path: file,
        excerpt: `[failed to read: ${(err as Error).message}]`,
        bytes: 0,
        truncated: false,
      });
    }
  }

  const system = opts.claudeMdOverride ?? (await loadClaudeMd(opts.config));
  const text = renderUserTurn(opts.config, excerpts);

  return { text, excerpts, system };
}

async function loadClaudeMd(cfg: WotwConfig): Promise<string> {
  const path = join(cfg.wiki_root, "CLAUDE.md");
  const contents = await readTextOrNullAsync(path);
  if (!contents) return DEFAULT_SYSTEM;
  return contents.slice(0, CLAUDE_MD_MAX_BYTES);
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

Rules:
  - Always produce at least one source-category page per raw file.
  - Always link related concepts bidirectionally.
  - Never modify files in raw/.
  - Never emit placeholder TODOs — write what you know.`;

function renderUserTurn(cfg: WotwConfig, excerpts: IngestionPrompt["excerpts"]): string {
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
  lines.push("## Expected output");
  lines.push("");
  lines.push("Write wiki pages using the Write tool. Use `readPage` / `listPages` as you see fit.");
  lines.push("Every new page must include full frontmatter. Keep body markdown concise,");
  lines.push("use `[[wiki-links]]` when referring to other pages, and cite source files");
  lines.push("in the `sources:` frontmatter list.");
  return lines.join("\n");
}
