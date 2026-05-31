# F2 — Multi-source biology — expected single-pass output

**Dimension (Phase A):** multi-source ingestion — two related source documents
that share concepts (ATP, mitochondria, inner membrane) ingested in one batch.

**Parity criterion (shipped single-pass providers):** structural validity +
concept coverage + cross-linking, NOT byte equality (LLM output is stochastic;
P3 adds fact-level precision/recall).

## Expected structural properties
- A wiki page per major concept, distributed across category dirs
  (`concept/`, `entity/`), plus `sources/` entries and an `index.md`.
- Each page carries valid frontmatter: `title`, `category`, `created`,
  `updated`, `sources`, `confidence`, `source_count`, `last_compiled`.
- Provenance chain contains an `ingest` record covering the batch, with
  `source_files`, `source_hashes`, `prompt_hash`, `response_hash`, `model_id`.
- Zero dead-letter entries.

## Expected concept coverage (key concepts that should appear as pages or be
## clearly covered)
- mitochondria (powerhouse of the cell; outer/inner membrane; cristae; matrix)
- ATP / adenosine triphosphate
- cellular respiration
- glycolysis, citric acid cycle (Krebs cycle), oxidative phosphorylation
- endosymbiotic theory / Lynn Margulis
- mitochondrial DNA (mtDNA)

## Expected cross-linking (the multi-source signal)
Because both sources reference ATP and the mitochondrial inner membrane, the
single-pass output should CROSS-LINK the mitochondria and cellular-respiration
material via `[[backlinks]]` / `related:` frontmatter — the two sources must not
produce two fully isolated islands.

## Parity break (STOP) would be
- No cross-references between the mitochondria and respiration material.
- Missing provenance ingest record, or dead-letter entries.
- A batch that fails to complete / crashes the config or ingestion path.
