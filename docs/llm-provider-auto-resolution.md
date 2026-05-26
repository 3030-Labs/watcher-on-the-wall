# LLM provider auto-resolution

> Why Pass B fact extraction defaults **on** under Claude Code CLI and
> Ollama, but **off** under Anthropic / OpenAI / Gemini, and how to
> override the default.

## The short version

| Provider | Runtime | `fact_extraction.enabled: "auto"` resolves to | Why |
|---|---|---|---|
| `cli` | Claude Code CLI (subscription) | **on** | Subscription is flat-rate; extra LLM calls have zero marginal cost. |
| `ollama` | Local | **on** | Local inference is your CPU/GPU; no per-token bill. |
| `anthropic` | API | **off** (unless `force_enabled: true`) | Metered. Fact extraction roughly doubles ingestion LLM cost. Opt-in required. |
| `openai` | API | **off** (unless `force_enabled: true`) | Metered. Same reasoning. |
| `gemini` | API | **off** (unless `force_enabled: true`) | Metered. Same reasoning. |

## What "fact extraction" is

Pass B (shipped in v0.8.0) added a second-layer retrieval index built
on **atomic facts** — `(entity, statement)` pairs and synthetic
questions extracted from each wiki page by a small LLM call at
ingestion time. The fact layer is what powers `query_facts` and the
`source_layer: "facts"` responses on `define` / `relate` /
`cite_sources` (see [`mcp-tools.md`](mcp-tools.md)).

Empirically, the fact layer ships **80%+ fewer tokens** than page-level
retrieval on atomic-question workloads. Strict value-add for the
client. But:

- It needs an LLM call **per page at ingest time**, on top of the
  existing wiki-write LLM call.
- That extra call is **NOT free** on metered providers — it
  approximately doubles per-page ingestion cost.
- Cost-free runtimes (Claude Code subscription, Ollama) absorb it
  silently; metered runtimes don't.

## The auto-resolution decision

The active resolver lives at
[`src/facts/extractor.ts:isExtractionActive()`](../src/facts/extractor.ts).
Its priority order is:

1. **Explicit `fact_extraction.enabled: false`** → off. No override.
2. **Explicit `fact_extraction.enabled: true`** → on. No override.
3. **`fact_extraction.enabled: "auto"`** (the default) → branch on runtime:
   - Runtime is `cli` (Claude Code CLI subscription) → on.
   - LLM provider is `ollama` → on.
   - `fact_extraction.force_enabled: true` → on (operator's explicit
     opt-in for metered).
   - Otherwise (metered API provider, no force) → **off**.

Every ingestion logs a `reason:` string explaining which branch fired —
grep `~/.wotw/daemon.log` for `auto + ` after a fresh ingestion to see
what the daemon decided and why.

## Why "off by default" on metered providers

There are three reasons:

1. **Cost surprise prevention.** A new self-hosted user who plugs in
   their Anthropic key and ingests a few hundred markdown files
   should not be surprised by a 2x bill versus what the README's
   30-second quickstart implies. Off-by-default is the safe posture.
   They can opt in once they understand the trade.
2. **The page-level retrieval is already excellent.** Pass A's
   `query_progressive` ships **86-99% fewer tokens** than the legacy
   `query` payload (see [`CONTEXT-EFFICIENCY-PASS-A.md`](../CONTEXT-EFFICIENCY-PASS-A.md)).
   Pass B's extra ~10pp on top of that is real but marginal — the
   user is not in a worst-case state without it.
3. **`fallback: "page-level"` makes the off-state graceful.** The
   client `define` / `relate` / `cite_sources` tools return a
   `source_layer: "page"` response with a `fallback` signal; agent
   clients route around it automatically. The user experience
   degrades gracefully, not catastrophically.

If we had defaulted Pass B on for metered providers, the first
support thread would be "I got billed $40 ingesting my personal
notes." Off-by-default avoids that thread.

## Why "on by default" on cost-free runtimes

The mirror argument:

1. **No cost surprise possible.** Subscription-covered CLI mode and
   local Ollama have zero marginal cost per LLM call. The user
   already paid (subscription) or owns the inference (CPU/GPU).
2. **The 80%+ retrieval win is too good to leave on the floor.**
   For atomic-question workloads — the most common shape of agent
   memory-tier queries — Pass B is the meaningful retrieval win of
   the year. Auto-on captures it without manual config.
3. **Discoverability.** A user who runs `wotw init`, picks Claude
   Code CLI, and ingests for two weeks should naturally end up on
   fact-extracted indices. They learn Pass B exists because it Just
   Works for them.

## How to override

In `wotw.config.yaml`:

```yaml
fact_extraction:
  enabled: "auto"        # the default; let the daemon pick
  force_enabled: false   # ignored under "auto" when runtime is cost-free
  budget:
    max_facts_per_page: 50
    max_questions_per_page: 10
```

To **force on** under a metered provider:

```yaml
fact_extraction:
  enabled: "auto"
  force_enabled: true    # opt-in to metered extraction
```

You will see this log line at the next ingestion:

```
INFO facts/extractor: extraction=active reason="auto + force_enabled=true + provider=anthropic (operator opt-in to metered extraction)"
```

To **force off** regardless of runtime:

```yaml
fact_extraction:
  enabled: false
```

You will see this log line:

```
INFO facts/extractor: extraction=inactive reason="fact_extraction.enabled=false (explicit)"
```

To **always on** regardless of runtime:

```yaml
fact_extraction:
  enabled: true
```

`enabled: true` overrides the auto branch entirely — even on metered
providers without `force_enabled`. Use this when you've decided as
operator that the cost is acceptable and you don't want subtle
runtime-dependent behaviour.

## Repopulating an existing wiki

If you've been ingesting without fact extraction and want to turn it
on:

```bash
# 1. Update config:
#    fact_extraction.enabled: true  (or force_enabled: true on auto)

# 2. Restart the daemon to pick up the config change:
wotw stop && wotw start

# 3. Rebuild the fact index over existing pages:
wotw facts reindex
```

`wotw facts reindex` is budget-gated and idempotent. It walks every
non-orphaned page, extracts facts + questions for any page that
doesn't already have them, and emits one provenance record per page
with `record_type: "facts_indexed"`. You can interrupt mid-run and
resume; already-extracted pages are skipped.

Expect to pay metered LLM cost equal to one extraction call per page.
The daemon refuses to start the reindex if `cost.max_daily_usd`
wouldn't accommodate it; lower `ingestion.concurrency` and re-run if
you hit that cap.

## How to verify what's running

```bash
wotw status --json | jq '.config.fact_extraction'
# expected: { enabled: "auto", force_enabled: false, ... }

# Last extraction decision logged at startup + per-ingest:
grep "facts/extractor" ~/.wotw/daemon.log | tail -5
```

## See also

- [`CONTEXT-EFFICIENCY-PASS-B.md`](../CONTEXT-EFFICIENCY-PASS-B.md) —
  benchmark methodology, per-provider extraction quality, deploy
  evidence.
- [`mcp-tools.md`](mcp-tools.md#query_facts) — the `query_facts` MCP
  surface and its response shape.
- [`self-hosted-byok.md`](self-hosted-byok.md) — picking and rotating
  the provider key.
- [`configuration.md`](configuration.md) — full schema for
  `wotw.config.yaml`.
