/**
 * Fact + FactQuestion types. Used by FactStore (persistent SQLite),
 * FactIndex (in-memory BM25), and the query_facts MCP tool.
 *
 * A Fact is the atomic unit of retrieval in the Pass B layer — an
 * entity + statement pair extracted from a wiki page, after Yanhong
 * Li / TTIC factual-decomposition (arXiv 2503.19574). Each fact is
 * linked back to the wiki page it came from so the client LLM can
 * still ground citations against the original markdown.
 *
 * A FactQuestion is a synthetic question generated at extraction time
 * (per Cambridge ALTA, arXiv 2405.12363) that maps to its parent fact.
 * Indexing questions in parallel with facts lets BM25 surface facts
 * matching the *shape* of the user's question, not just literal
 * keyword overlap.
 */

export interface Fact {
  /** Auto-incremented primary key from SQLite. */
  id: number;
  /** Wiki-relative path of the source page (e.g. `wiki/concepts/photosynthesis.md`). */
  wiki_page_id: string;
  /** Subject of the fact (typically a noun phrase). */
  entity: string;
  /** Predicate / description of the entity. */
  statement: string;
  /**
   * SHA-256 fingerprint of canonical (entity + statement + wiki_page_id +
   * created_at). Unique per row — re-extractions of the same content land
   * in new rows with new hashes, and supersession links the lineage via
   * `superseded_at` on the prior row.
   */
  fact_hash: string;
  /** ISO 8601 timestamp of extraction. */
  created_at: string;
  /** ISO 8601 timestamp when this fact was superseded; null = active. */
  superseded_at: string | null;
}

export interface FactQuestion {
  id: number;
  fact_id: number;
  question_text: string;
  question_hash: string;
}

/** Convenience: a Fact bundled with its synthetic questions. */
export interface FactWithQuestions {
  fact: Fact;
  questions: FactQuestion[];
}
