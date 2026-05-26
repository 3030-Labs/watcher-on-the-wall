# Sample 4 — research notes: pre-2026 retrieval landscape

Survey of where retrieval-augmented generation (RAG) sits as of
early 2026 based on the last six months of arxiv + practitioner blog
output. Not exhaustive — focused on what's actually deployed vs.
what's interesting in a paper.

## What's settled

- **Embedding-based retrieval is the default.** OpenAI, Anthropic, and
  the big inference providers all ship embedding APIs. The cost has
  dropped 10x since 2024.
- **Hybrid retrieval (BM25 + dense) outperforms either alone** on most
  benchmarks. Cohere's "Rerank" + similar products commoditized the
  re-ranking step.
- **Chunking strategy matters more than embedding model choice** for
  most production workloads. Smart chunking (semantic boundaries vs
  fixed-token) is where most of the easy wins live.

## What's contested

- **Long-context vs RAG.** Frontier models hitting 1M+ context window
  (Claude, Gemini Ultra) raised the question of whether RAG is still
  needed. Empirically: yes, for cost reasons. A 1M-context call is
  ~30x the price of a small-context call with retrieval; only edge
  cases justify it.
- **Vector-DB-vs-application-DB.** The market has split. Specialty
  vector stores (Pinecone, Weaviate) struggle as Postgres extensions
  (pgvector) hit acceptable performance at lower TCO.

## What's interesting (paper-stage)

- Retrieval over **atomic-fact extractions** rather than passages,
  per Li et al. (TTIC 2026). 80%+ token reduction on
  atomic-question workloads, at the cost of an extraction LLM pass at
  ingestion time. Promising for memory-tier use cases where ingestion
  is amortized over many queries.
- **Provenance-aware retrieval**: returning not just the answer but
  the chain of inputs that produced it. Active research; not yet a
  product category.
