/**
 * SQLite-backed fact store. Persistent layer for the Pass B fact +
 * synthetic-question index. Lives at `.wotw/facts.db` under the wiki
 * root. The daemon loads everything into a {@link FactIndex} (minisearch
 * BM25) at startup — same pattern as `WikiSearch` over the page corpus.
 *
 * Migrations are gated on `PRAGMA user_version`; this is the
 * version-1 initial schema. Future migrations bump the version + add
 * idempotent ALTER/CREATE statements.
 *
 * Backward compatibility: a daemon with no facts.db on disk opens the
 * DB on first use (creating the file + schema). Pre-existing wikis are
 * unaffected — the fact layer is opt-in via `fact_extraction.enabled`,
 * defaulting to "auto" (active only for cost-free runtimes).
 *
 * Concurrency: better-sqlite3 is synchronous + uses a single connection.
 * The daemon's pipeline is single-writer (IngestionQueue is serial),
 * so no in-process locking is required.
 *
 * Pass 008 BYOK: this module touches no API keys. The extractor that
 * fills it (`src/facts/extractor.ts`) reads keys at call-time via the
 * existing provider abstraction.
 */
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { ensureDirSync } from "../utils/fs.js";
import { getLogger } from "../utils/logger.js";
import type { Fact, FactQuestion } from "./types.js";

const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS facts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wiki_page_id TEXT NOT NULL,
    entity TEXT NOT NULL,
    statement TEXT NOT NULL,
    fact_hash TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    superseded_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facts_wiki_page_id ON facts(wiki_page_id);
  CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(wiki_page_id) WHERE superseded_at IS NULL;

  CREATE TABLE IF NOT EXISTS fact_questions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fact_id INTEGER NOT NULL,
    question_text TEXT NOT NULL,
    question_hash TEXT UNIQUE NOT NULL,
    FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_fact_questions_fact_id ON fact_questions(fact_id);
`;

export interface FactStoreOptions {
  /** Absolute path to the SQLite file. Created if missing. */
  path: string;
  /** When true, open the DB in-memory (used by tests). */
  inMemory?: boolean;
}

export interface InsertFactInput {
  wiki_page_id: string;
  entity: string;
  statement: string;
}

/**
 * The persistent fact store. All methods are synchronous because
 * better-sqlite3 is sync; the surrounding code awaits at higher layers
 * for consistency with the rest of the daemon's async surface.
 */
export class FactStore {
  readonly path: string;
  private readonly db: Database.Database;

  constructor(opts: FactStoreOptions) {
    this.path = opts.path;
    if (!opts.inMemory) {
      ensureDirSync(dirname(this.path));
    }
    this.db = new Database(opts.inMemory ? ":memory:" : this.path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  /** Run idempotent migrations up to the current schema version. */
  private migrate(): void {
    const log = getLogger("fact-store");
    const currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    if (currentVersion === SCHEMA_VERSION) return;
    if (currentVersion > SCHEMA_VERSION) {
      throw new Error(
        `facts.db at ${this.path} is at schema version ${currentVersion} (newer than this daemon's ${SCHEMA_VERSION}) — refusing to downgrade`,
      );
    }
    log.info({ from: currentVersion, to: SCHEMA_VERSION }, "running facts.db migrations");
    this.db.exec(SCHEMA_SQL);
    this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Insert a fact + return its row id and assigned fact_hash. The hash
   * is computed from the canonical (entity + statement + wiki_page_id +
   * created_at) so repeat extractions land in distinct rows; supersession
   * links the lineage on the prior row.
   */
  insertFact(input: InsertFactInput): { id: number; fact_hash: string; created_at: string } {
    const created_at = new Date().toISOString();
    const fact_hash = factHash(input.entity, input.statement, input.wiki_page_id, created_at);
    const result = this.db
      .prepare(
        `INSERT INTO facts (wiki_page_id, entity, statement, fact_hash, created_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.wiki_page_id, input.entity, input.statement, fact_hash, created_at);
    return { id: Number(result.lastInsertRowid), fact_hash, created_at };
  }

  /**
   * Bulk-insert synthetic questions for a fact. Each gets a content hash
   * computed from (fact_id + question_text). Duplicate questions for the
   * same fact (same hash) are silently skipped via INSERT OR IGNORE.
   */
  insertQuestions(factId: number, questions: string[]): FactQuestion[] {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO fact_questions (fact_id, question_text, question_hash) VALUES (?, ?, ?)`,
    );
    const inserted: FactQuestion[] = [];
    const tx = this.db.transaction((qs: string[]) => {
      for (const q of qs) {
        if (typeof q !== "string" || q.trim().length === 0) continue;
        const hash = questionHash(factId, q);
        const result = insert.run(factId, q, hash);
        if (Number(result.changes) > 0) {
          inserted.push({
            id: Number(result.lastInsertRowid),
            fact_id: factId,
            question_text: q,
            question_hash: hash,
          });
        }
      }
    });
    tx(questions);
    return inserted;
  }

  /**
   * Supersede every active fact for `wikiPageId` (set their
   * `superseded_at`). Returns the list of superseded fact_hashes — the
   * caller writes these into a provenance record's
   * `fact_hashes_superseded` field.
   */
  supersedeByWikiPage(wikiPageId: string, when: string = new Date().toISOString()): string[] {
    const rows = this.db
      .prepare(`SELECT fact_hash FROM facts WHERE wiki_page_id = ? AND superseded_at IS NULL`)
      .all(wikiPageId) as { fact_hash: string }[];
    const hashes = rows.map((r) => r.fact_hash);
    if (hashes.length > 0) {
      this.db
        .prepare(
          `UPDATE facts SET superseded_at = ? WHERE wiki_page_id = ? AND superseded_at IS NULL`,
        )
        .run(when, wikiPageId);
    }
    return hashes;
  }

  /** Return every active fact across the corpus. */
  listActive(): Fact[] {
    return this.db
      .prepare(
        `SELECT id, wiki_page_id, entity, statement, fact_hash, created_at, superseded_at FROM facts WHERE superseded_at IS NULL`,
      )
      .all() as Fact[];
  }

  /** Return every question linked to facts that are still active. */
  listActiveQuestions(): FactQuestion[] {
    return this.db
      .prepare(
        `SELECT q.id, q.fact_id, q.question_text, q.question_hash
         FROM fact_questions q
         INNER JOIN facts f ON f.id = q.fact_id
         WHERE f.superseded_at IS NULL`,
      )
      .all() as FactQuestion[];
  }

  /** Look up a single fact by primary key (returns null if absent). */
  getFact(id: number): Fact | null {
    const row = this.db
      .prepare(
        `SELECT id, wiki_page_id, entity, statement, fact_hash, created_at, superseded_at FROM facts WHERE id = ?`,
      )
      .get(id) as Fact | undefined;
    return row ?? null;
  }

  /** All facts (active + superseded) for a given wiki page. */
  listByWikiPage(wikiPageId: string): Fact[] {
    return this.db
      .prepare(
        `SELECT id, wiki_page_id, entity, statement, fact_hash, created_at, superseded_at FROM facts WHERE wiki_page_id = ? ORDER BY created_at`,
      )
      .all(wikiPageId) as Fact[];
  }

  /** Total active fact count (cheap, used for "is the layer populated?" checks). */
  activeCount(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as n FROM facts WHERE superseded_at IS NULL`)
      .get() as { n: number };
    return row.n;
  }

  /** Schema version reported by PRAGMA user_version (cheap, used by tests). */
  schemaVersion(): number {
    return this.db.pragma("user_version", { simple: true }) as number;
  }

  /** Close the underlying handle. Idempotent. */
  close(): void {
    if (this.db.open) this.db.close();
  }
}

/** SHA-256 of canonical (entity, statement, wiki_page_id, created_at). */
export function factHash(
  entity: string,
  statement: string,
  wikiPageId: string,
  createdAt: string,
): string {
  return createHash("sha256")
    .update(`${wikiPageId} ${entity} ${statement} ${createdAt}`)
    .digest("hex");
}

/** SHA-256 of (fact_id, question_text). */
export function questionHash(factId: number, question: string): string {
  return createHash("sha256").update(`${factId} ${question}`).digest("hex");
}
