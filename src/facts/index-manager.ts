/**
 * In-memory BM25 index over the fact + synthetic-question corpus.
 * Two parallel minisearch instances:
 *
 *   - `factsEngine`   — indexes the entity + statement of every active
 *                       fact.
 *   - `questionsEngine` — indexes the question_text of every synthetic
 *                       question, tagged with its parent fact_id.
 *
 * At query time both engines run, then results are fused into a single
 * per-fact score using the weighting documented in the Pass B goal:
 *   - questions:  0.6
 *   - facts:      0.4
 *
 * Question-shape matching wins on weight because the Cambridge ALTA
 * pattern shows it dominates atomic-question quality (a user asking
 * "what is X?" hits the synthetic question for X more reliably than
 * keyword overlap on the underlying statement).
 *
 * BM25-only commitment: minisearch is the same BM25 implementation the
 * rest of the daemon uses for wiki pages. No vector code paths.
 */
import MiniSearch from "minisearch";
import type { Fact, FactQuestion } from "./types.js";

/** Question-matched contribution weight to the fused score. */
export const QUESTION_WEIGHT = 0.6;
/** Fact-text-matched contribution weight to the fused score. */
export const FACT_WEIGHT = 0.4;

interface FactDoc {
  id: number;
  entity: string;
  statement: string;
  fact_hash: string;
  wiki_page_id: string;
}

interface QuestionDoc {
  id: number;
  question_text: string;
  fact_id: number;
  question_hash: string;
}

export interface FactSearchHit {
  fact: Fact;
  /** Fused score across the questions + facts indices. */
  score: number;
  /** Whether this hit was matched via the questions index. */
  matched_via_question: boolean;
  /** Whether this hit was matched via the facts (entity/statement) index. */
  matched_via_fact: boolean;
}

/**
 * Two-engine fused BM25 index. Reuses the same minisearch dep as
 * `WikiSearch`. Empty until {@link rebuild} is called.
 */
export class FactIndex {
  private readonly factsEngine: MiniSearch<FactDoc>;
  private readonly questionsEngine: MiniSearch<QuestionDoc>;
  private factsById = new Map<number, Fact>();

  constructor() {
    this.factsEngine = new MiniSearch<FactDoc>({
      idField: "id",
      fields: ["entity", "statement"],
      storeFields: ["fact_hash", "wiki_page_id"],
      searchOptions: {
        boost: { entity: 3 },
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
    this.questionsEngine = new MiniSearch<QuestionDoc>({
      idField: "id",
      fields: ["question_text"],
      storeFields: ["fact_id", "question_hash"],
      searchOptions: {
        fuzzy: 0.2,
        prefix: true,
        combineWith: "OR",
      },
    });
  }

  /** Replace the in-memory index from the live persistent state. */
  rebuild(facts: Fact[], questions: FactQuestion[]): void {
    this.factsEngine.removeAll();
    this.questionsEngine.removeAll();
    this.factsById = new Map(facts.map((f) => [f.id, f]));
    if (facts.length > 0) {
      this.factsEngine.addAll(
        facts.map((f) => ({
          id: f.id,
          entity: f.entity,
          statement: f.statement,
          fact_hash: f.fact_hash,
          wiki_page_id: f.wiki_page_id,
        })),
      );
    }
    if (questions.length > 0) {
      this.questionsEngine.addAll(
        questions.map((q) => ({
          id: q.id,
          question_text: q.question_text,
          fact_id: q.fact_id,
          question_hash: q.question_hash,
        })),
      );
    }
  }

  /** Add a single fact + its questions to the index without a full rebuild. */
  add(fact: Fact, questions: FactQuestion[] = []): void {
    this.factsById.set(fact.id, fact);
    this.factsEngine.add({
      id: fact.id,
      entity: fact.entity,
      statement: fact.statement,
      fact_hash: fact.fact_hash,
      wiki_page_id: fact.wiki_page_id,
    });
    for (const q of questions) {
      this.questionsEngine.add({
        id: q.id,
        question_text: q.question_text,
        fact_id: q.fact_id,
        question_hash: q.question_hash,
      });
    }
  }

  /** Drop a fact (and any questions tagged to it) from the index. */
  remove(factId: number, questionIds: number[] = []): void {
    if (this.factsById.has(factId)) {
      this.factsEngine.remove({ id: factId } as FactDoc);
      this.factsById.delete(factId);
    }
    for (const qid of questionIds) {
      try {
        this.questionsEngine.remove({ id: qid } as QuestionDoc);
      } catch {
        // minisearch throws on remove-missing; ignore.
      }
    }
  }

  /**
   * BM25 search across both indices, fuse by weighted sum, return top-k
   * facts. When the query has zero hits across both engines, returns an
   * empty array (caller falls back to page-level retrieval).
   */
  search(query: string, k = 5): FactSearchHit[] {
    if (!query.trim() || this.factsById.size === 0) return [];

    const factHits = this.factsEngine.search(query);
    const questionHits = this.questionsEngine.search(query);

    // factId → { fact match score, question match score }.
    const merged = new Map<number, { factScore: number; questionScore: number }>();
    for (const h of factHits) {
      const id = h.id as number;
      const slot = merged.get(id) ?? { factScore: 0, questionScore: 0 };
      slot.factScore = Math.max(slot.factScore, h.score);
      merged.set(id, slot);
    }
    for (const h of questionHits) {
      const factId = (h as unknown as { fact_id: number }).fact_id;
      const slot = merged.get(factId) ?? { factScore: 0, questionScore: 0 };
      slot.questionScore = Math.max(slot.questionScore, h.score);
      merged.set(factId, slot);
    }

    const fused: FactSearchHit[] = [];
    for (const [id, { factScore, questionScore }] of merged) {
      const fact = this.factsById.get(id);
      if (!fact) continue;
      fused.push({
        fact,
        score: factScore * FACT_WEIGHT + questionScore * QUESTION_WEIGHT,
        matched_via_fact: factScore > 0,
        matched_via_question: questionScore > 0,
      });
    }
    fused.sort((a, b) => b.score - a.score);
    return fused.slice(0, k);
  }

  /** Number of active facts in the index. */
  size(): number {
    return this.factsById.size;
  }

  /** Total number of synthetic questions in the index. */
  questionCount(): number {
    return this.questionsEngine.documentCount;
  }
}
