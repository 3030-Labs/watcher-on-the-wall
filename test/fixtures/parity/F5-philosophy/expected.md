# F5 — Philosophy / real-world — expected single-pass output

**Dimension (Phase A):** abstract conceptual / real-world content (philosophy)
rather than concrete natural-science facts. Tests that the single-pass pipeline
handles abstract doctrines, named figures, and historical relationships without
degrading into malformed output.

**Parity criterion (shipped single-pass providers):** structurally-valid wiki
output covering the doctrine + the named figures, with cross-links between the
school and its proponents. NOT byte equality.

## Expected structural properties
- Pages distributed across `concept/` (doctrines) and `entity/` (people),
  plus `sources/` + `index.md`.
- Valid frontmatter on every page.
- Provenance `ingest` record for the batch; zero dead-letters.

## Expected concept coverage
- Stoicism (concept): founded by Zeno of Citium, ~300 BCE, Stoa Poikile.
- Dichotomy of control (within vs not within our power).
- Virtue as the only true good / living in accordance with nature.
- Zeno of Citium (entity / founder).
- Later Stoics: Seneca, Epictetus, Marcus Aurelius (Meditations).
- Influence on cognitive behavioral therapy.

## Expected cross-linking
The Stoicism concept page and the philosopher entity pages (Zeno, Marcus
Aurelius, Epictetus, Seneca) should be `[[backlink]]` / `related:` connected —
the school links to its proponents.

## Parity break (STOP) would be
- Malformed pages (missing frontmatter, empty bodies) on abstract content.
- Named figures dropped entirely (no Zeno / no later Stoics).
- Missing provenance ingest record, dead-letters, or an ingestion crash.
