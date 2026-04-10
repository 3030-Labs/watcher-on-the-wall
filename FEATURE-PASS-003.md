# Feature Pass 003 — Knowledge Health System

**Date:** 2026-04-09
**Base tree:** post-Feature-Pass-002 (272 tests, 63 source files)
**Result:** 300 tests, 65 source files, all 5 gates green

---

## Features shipped

### 1. Knowledge Quality Scoring

Every wiki page gets a health score (0–100) based on five weighted factors:

| Factor | Weight | Source |
|--------|--------|--------|
| Staleness | 0.25 | Provenance chain — days since last ingest/heal record |
| Source availability | 0.25 | Checks if raw source files still exist on disk |
| Link health | 0.20 | Fraction of `[[wikilinks]]` that resolve to existing pages |
| Duplicate risk | 0.15 | Search-index similarity to the closest non-self page |
| Contradiction risk | 0.15 | LLM-detected contradictions (off by default) |

Staleness uses configurable day thresholds (default: 7/30/90/180/365 →
100/80/60/40/20/0). The overall score is a weighted average with
inverted risk factors.

**Implementation:** `src/wiki/health.ts` (~517 LoC)

### 2. Deduplication Detection + Auto-Merge

Pages with high search-index similarity (`duplicate_threshold`, default
60) are detected pairwise, then grouped transitively using union-find.
When `--fix` is used, the LLM merges each duplicate group into one
page. Surplus pages get `status: merged` with `merged_into:` pointing
to the survivor.

**Implementation:** `src/wiki/health.ts` (`groupDuplicates`,
`computeDuplicateRisk`) + `src/wiki/heal-handlers.ts` (`healDuplicate`)

### 3. Auto-Healing via `wotw lint --fix`

New flags on `wotw lint`: `--fix`, `--yes`, `--json`.

Five heal handlers dispatch by finding kind:

| Handler | LLM? | What it does |
|---------|------|--------------|
| `healStale` | Yes | Review and refresh stale page content |
| `healDuplicate` | Yes | Merge redundant pages into one |
| `healBrokenLinks` | Yes | Fix or remove broken `[[wikilinks]]` |
| `healMissingBacklinks` | No | Add missing slug to target's `related:` |
| `healContradiction` | Yes | Resolve factual contradictions |

Safety guardrails:
- Budget pre-flight via `CostTracker` before every LLM call
- `max_fixes_per_run` cap (default 10)
- `type: "heal"` provenance records with `metadata.heal_kind`
- Git commits for auditability
- `--yes` required (or interactive confirmation) before healing

**Implementation:** `src/wiki/heal-handlers.ts` (~450 LoC),
`src/cli/commands/lint.ts` (rewritten)

### 4. Health Surfacing

- **`wotw status`** — one-line health summary: "Wiki health: N avg
  (M need attention)"
- **`get_stats` MCP tool** — returns `health.avg_score`,
  `pages_below_50`, `lowest_scoring_page`
- **`LintScheduler`** — gains `auto_fix` support; when
  `lint.auto_fix: true`, the daemon scheduler runs
  `lint --fix --yes` automatically

---

## Type system changes

- `OperationType`: added `"heal"`
- `WikiPageStatus`: added `"merged"`, `"stale"`
- `WikiFrontmatter`: added `merged_into?: string`,
  `contradictions?: string[]`
- `WotwConfig`: added `health:` block, `lint.auto_fix: boolean`

---

## New files

| File | LoC | Purpose |
|------|-----|---------|
| `src/wiki/health.ts` | ~517 | Health scoring, report generation, duplicate grouping |
| `src/wiki/heal-handlers.ts` | ~450 | LLM-powered heal handlers + dispatcher |
| `docs/knowledge-health.md` | 170 | Full health system documentation |
| `test/unit/health-scoring.test.ts` | 15 tests | Scoring factor tests |
| `test/unit/dedup-detection.test.ts` | 4 tests | Union-find grouping tests |
| `test/unit/heal-handlers.test.ts` | 5 tests | Heal handler tests (mocked LLM) |
| `test/integration/health-report.test.ts` | 2 tests | Full report integration tests |
| `test/integration/lint-fix.test.ts` | 2 tests | Lint --fix flow integration tests |

## Modified files

| File | Changes |
|------|---------|
| `src/utils/types.ts` | Added "heal" op type, "merged"/"stale" statuses, health config, lint.auto_fix |
| `src/daemon/config.ts` | Health defaults, deep-merge for weights, lint.auto_fix default |
| `src/wiki/page.ts` | Parsing/serialization for merged_into, contradictions, new statuses |
| `src/cli/commands/lint.ts` | Rewritten: health report + heal dispatch + --fix/--yes/--json |
| `src/cli/commands/status.ts` | Health summary line via dynamic import |
| `src/server/tools.ts` | Health summary in get_stats via dynamic import |
| `src/daemon/lint-scheduler.ts` | auto_fix support, updated runner type signature |
| `docs/configuration.md` | health: block, lint.auto_fix, feature notes |
| `docs/cli-reference.md` | wotw lint section rewritten |
| `docs/provenance.md` | "heal" type + "Heal records" section |
| `docs/mcp-tools.md` | health object in get_stats response |

---

## Configuration additions

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
  auto_fix: false  # new
```

---

## Test delta

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Source files | 63 | 65 | +2 |
| Source LoC | ~9,609 | ~10,831 | +1,222 |
| Test files | 26 | 31 | +5 |
| Test LoC | ~4,408 | ~5,208 | +800 |
| Tests | 272 | 300 | +28 |
| CLI bundle | ~215 KB | ~246 KB | +31 KB |

---

## Quality gates

All five gates green after Feature Pass 003:

```
pnpm typecheck     → 0 errors
pnpm lint          → 0 errors, 0 warnings
pnpm format:check  → All matched files use Prettier code style!
pnpm test          → 31 passed (31) / 300 passed (300)
pnpm build         → ESM + DTS success
```
