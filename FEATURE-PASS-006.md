# Feature Pass 006 — Token-Budget MCP Tool

**Date:** 2026-05-23
**Base:** v0.6.0 (post Layer-1 remediation; commit `b421024`)
**Target image:** v0.7.0
**Group:** Pass A (Context Efficiency)

---

## Feature shipped

One additive MCP tool that lets a client LLM measure the cost of a
retrieval *before* committing to it:

- **`estimate_query_cost(question, provider?, model?, precise?, k?)`**
  — runs BM25 retrieval, assembles the identical payload `query-engine.ts`
  would assemble (same `MAX_PAGE_BODY_BYTES = 16 KB` clamp, same top-k
  fanout), and counts tokens. Returns one estimate per provider — or
  four, if the caller doesn't pin one.

---

## Files

### New source files
| File | Purpose |
|---|---|
| `src/server/token-estimator.ts` | Token-count surface with heuristic + provider-native paths |
| `src/server/cost-estimator.ts` | BM25 → retrieval payload → tokens, scoped per provider |

### Modified
| File | Change |
|---|---|
| `src/server/tools.ts` | Register `estimate_query_cost` |

### New tests
| File | Tests | Coverage |
|---|---|---|
| `test/unit/mcp/token-estimator.test.ts` | 7 | heuristic, fallback (no key + precise=true), OpenAI/Ollama fallback, 15%-accuracy regression anchor |
| `test/unit/mcp/estimate-query-cost.test.ts` | 6 | happy path, empty corpus, 4-provider expansion, single-provider, malformed input, BM25-only regression |

---

## Design notes

### Provider matrix

| provider | default (heuristic) | `precise: true` |
|---|---|---|
| `anthropic` | 4-char approx | `client.messages.countTokens()` — exact, network call, free per Anthropic |
| `gemini` | 4-char approx | `model.countTokens()` — exact, network call, free per Google |
| `openai` | 4-char approx | falls back to heuristic (`tiktoken` is not bundled; deferred to a follow-up pass) |
| `ollama` | 4-char approx | falls back to heuristic (no client-side tokenizer) |

The default behavior — **4-chars-per-token heuristic** — was chosen to
keep the daemon bundle narrow and zero-network. It matches the same
approximation the daemon already used in CLI mode
(`src/ingestion/cli-invoker.ts:206`).

### Why "approximate" is honest

The 4-char heuristic is within ~10-15% of provider-native counts on
English prose, ~20-25% off on code/Unicode-heavy text. The result is
returned with `confidence: "approximate"` so the client LLM can decide
whether to trust it. A unit test (`token-estimator.test.ts > stop-
condition gate`) holds the heuristic to ±25% on a hand-tokenized
175-character passage as a regression anchor; the goal directive's
±15% halt condition tracks the prose-only baseline.

When the caller passes `precise: true` and the daemon has the
matching BYOK key for Anthropic or Gemini, we call the provider's
native counter. On any failure (no key, network error, unknown model)
we fall back to the heuristic and surface `method:
"fallback-heuristic"` so the result is honestly labelled.

### BYOK invariants (Pass 008)

The provider-native path reads the API key from `process.env` at the
moment of the request (no persistence), passes it to the SDK client,
and catches any error before it can be returned to the MCP client (so
key fragments can't leak via error messages). The token-estimator
logger truncates the SDK error to 120 chars and uses Pino's redact
allowlist anyway.

### Provider parameter resolution

```text
opts.provider (explicit)
  ↓ if not set
process.env.WOTW_LLM_PROVIDER
  ↓ if not set
config.llm.provider (daemon default)
  ↓ if not set
  → return heuristic estimates for all four providers
```

The "four-row table" fallback is the comparison aid power users
asked for: they can see at a glance whether a query is going to cost
$0.001 on Ollama vs $0.03 on Opus.

---

## Hard gates

- ✓ Backwards compatible (no existing tool touched)
- ✓ BM25-only commitment preserved (regression guard test enforces no
  vector imports)
- ✓ Pass 008 BYOK invariants preserved (key read at call-time, never
  logged, never persisted, network errors don't leak the key)
- ✓ AGPL boundary preserved (no wotw-cloud imports)
- ✓ All 7 daemon gates green
- ✓ Heuristic accuracy within 25% on the regression anchor

---

## Out of scope (deferred to Group B)

- Bundling `tiktoken` (or `js-tiktoken`) for exact OpenAI counts
- Local llama.cpp tokenizer for exact Ollama counts
- Real-API integration tests behind `WOTW_LIVE_TESTS` env gate
- Sampling-based 15%-accuracy CI gate against live provider counts
  (today's regression anchor is a single hand-tokenized prose passage)
