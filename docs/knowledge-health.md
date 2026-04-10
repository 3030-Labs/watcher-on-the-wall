# Knowledge health

`wotw` computes a health score (0–100) for every wiki page based on
five objective factors. The scores, together with actionable findings
(stale pages, broken links, orphans, duplicates, missing backlinks),
form a **health report** that powers `wotw lint`, `wotw status`,
and the `get_stats` MCP tool.

---

## Health factors

Each factor produces a 0–100 value. Higher is healthier, except for
duplicate risk and contradiction risk where 0 means "no risk" (best).

| Factor | Weight | What it measures |
|--------|--------|------------------|
| **Staleness** | 0.25 | Days since the last ingest/heal provenance record that wrote to this page. Configurable day thresholds map to scores. |
| **Source availability** | 0.25 | Fraction of raw source files (from provenance) that still exist on disk. Orphaned pages score 0. |
| **Link health** | 0.20 | Fraction of `[[wikilinks]]` in the page body that resolve to existing pages. No links = 100. |
| **Duplicate risk** | 0.15 | Similarity to the closest non-self page in the search index, normalized via heuristic thresholds. |
| **Contradiction risk** | 0.15 | Set by the optional LLM contradiction detection pass. 0 by default. |

The overall score is a weighted average:

```
score = staleness × w₁ + sourceAvailability × w₂ + linkHealth × w₃
      + (100 − duplicateRisk) × w₄ + (100 − contradictionRisk) × w₅
```

All weights are configurable via `health.weights`.

---

## Staleness scoring

Staleness uses configurable day thresholds and score buckets. The
default maps:

| Days since last update | Score |
|------------------------|-------|
| ≤ 7 | 100 |
| ≤ 30 | 80 |
| ≤ 90 | 60 |
| ≤ 180 | 40 |
| ≤ 365 | 20 |
| > 365 or no provenance | 0 |

A page with no provenance records (never ingested/healed) gets the
lowest score. The thresholds and scores are tunable via
`health.staleness_thresholds` and `health.staleness_scores`.

---

## Findings

The health report emits structured findings:

| Kind | Severity | Auto-fixable | Description |
|------|----------|--------------|-------------|
| `stale` | high/medium | Yes | Page staleness below `auto_fix_staleness_below` (default 40). |
| `broken-link` | high/medium | Yes | One or more `[[wikilinks]]` point to nonexistent pages. |
| `orphan` | medium | No | Source files deleted; page retained with `status: orphaned`. |
| `duplicate` | medium | Yes | Multiple pages cover the same topic (detected via search index similarity, grouped transitively). |
| `missing-backlink` | low | Yes | Page A references B in `related:` but B doesn't reference A back. |
| `contradiction` | high | Yes | LLM-detected factual contradictions between pages (requires `health.detect_contradictions: true`). |

---

## Auto-healing (`wotw lint --fix`)

When `--fix` is passed, the lint command dispatches each auto-fixable
finding to a specialized heal handler:

| Finding kind | Handler | Uses LLM? | What it does |
|--------------|---------|-----------|--------------|
| `stale` | `healStale` | Yes | Prompts the LLM to review and refresh the page content. |
| `duplicate` | `healDuplicate` | Yes | Merges redundant pages — the LLM writes the consolidated page and marks others as `status: merged`. |
| `broken-link` | `healBrokenLinks` | Yes | Prompts the LLM to fix or remove broken wikilinks. |
| `missing-backlink` | `healMissingBacklinks` | No | Deterministic — adds the missing slug to the target page's `related:` array. |
| `contradiction` | `healContradiction` | Yes | Prompts the LLM to resolve contradictions and update the affected pages. |

### Safety guardrails

- **Budget pre-flight.** Every LLM heal call checks `CostTracker`
  before invoking. If the daily or per-operation budget would be
  exceeded, the heal is skipped.
- **Max fixes per run.** `health.max_fixes_per_run` (default 10) caps
  how many findings are healed in a single lint pass.
- **Provenance.** Every heal operation appends a `type: "heal"` record
  to the provenance chain with `metadata.heal_kind` identifying the
  finding type.
- **Git commits.** Healed changes are committed to git for
  auditability.
- **Confirmation.** Without `--yes`, the CLI prompts for confirmation
  before healing (unless `lint.auto_fix` is true in the daemon
  scheduler path).

---

## Duplicate detection

Duplicates are detected via the minisearch index:

1. For each page, the search index is queried with `title + tags`.
2. If the best non-self match exceeds `health.duplicate_threshold`
   (default 60), a pairwise duplicate is recorded.
3. Pairwise duplicates are grouped transitively using union-find to
   form duplicate groups (e.g., if A≈B and B≈C, then {A, B, C} is one
   group).

When healing, the LLM merges all pages in a group into one consolidated
page. The others are marked `status: merged` with a `merged_into:`
frontmatter field pointing to the survivor.

---

## Contradiction detection

Contradiction detection is **off by default** (`health.detect_contradictions: false`)
because it requires LLM calls per page group and can be expensive.

When enabled, pages sharing overlapping tags are grouped and the LLM is
asked to identify factual contradictions. Detected contradictions are
stored in the page frontmatter as `contradictions: [slug1, slug2]` and
emitted as high-severity findings.

---

## Configuration

All health settings live under the `health:` key in `wotw.config.yaml`:

```yaml
health:
  staleness_thresholds: [7, 30, 90, 180, 365]
  staleness_scores: [100, 80, 60, 40, 20, 0]
  weights:
    staleness: 0.25
    source_availability: 0.25
    link_health: 0.20
    duplicate_risk: 0.15
    contradiction_risk: 0.15
  duplicate_threshold: 60
  auto_fix_staleness_below: 40
  max_fixes_per_run: 10
  detect_contradictions: false

lint:
  schedule_enabled: false
  interval_hours: 24
  auto_fix: false  # when true, daemon scheduler runs lint --fix --yes
```

See [configuration.md](configuration.md) for the full schema.

---

## Surfacing

Health data is surfaced in three places:

1. **`wotw lint`** — prints the full health report with per-page scores,
   findings, and summary. `--json` outputs machine-readable JSON.
   `--fix` heals auto-fixable findings.
2. **`wotw status`** — shows a one-line health summary: average score
   and count of pages needing attention (score < 50).
3. **`get_stats` MCP tool** — returns `health.avg_score`,
   `health.pages_below_50`, and `health.lowest_scoring_page` in the
   stats response.
