#!/usr/bin/env bash
#
# parity-fixture-run.sh — Multi-LLM verify-and-harness arc, Phase 2 tool.
#
# Drives the SHIPPED single-pass daemon (the artifact this arc verifies) over a
# parity fixture through the REAL loadConfig chain, in CLI mode (claude binary,
# subscription, zero API key). Prints the resulting wiki tree + provenance
# record summary + dead-letter status so a parity run can be compared against
# the fixture's authored `expected.md` characterization.
#
# This is a verification tool, not a CI unit test — it needs the `claude` binary
# (or an API key) and is gated out of the mocked suite. P4 wires the
# cassette-based CI path.
#
# Usage:
#   scripts/parity-fixture-run.sh --raw <dir> --vault <dir> \
#       [--edit-raw <dir>] [--port N] [--timeout S] [--model M]
#
# --edit-raw drops a SECOND batch after the first completes, exercising the
# edit-existing-page (supersede) path (fixture F3).
set -euo pipefail

RAW=""; VAULT=""; EDIT_RAW=""; PORT=8799; TIMEOUT=180; MODEL="claude-haiku-4-5"
CLI="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/dist/cli/index.js"

while [ $# -gt 0 ]; do
  case "$1" in
    --raw) RAW="$2"; shift 2;;
    --vault) VAULT="$2"; shift 2;;
    --edit-raw) EDIT_RAW="$2"; shift 2;;
    --port) PORT="$2"; shift 2;;
    --timeout) TIMEOUT="$2"; shift 2;;
    --model) MODEL="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$RAW" ] && [ -n "$VAULT" ] || { echo "need --raw and --vault" >&2; exit 2; }

rm -rf "$VAULT"; mkdir -p "$VAULT/raw" "$VAULT/wiki"
cat > "$VAULT/wotw.yaml" <<EOF
wiki_root: ./wiki
raw_path: ./raw
execution:
  mode: cli
  cli_path: claude
  cli_model: $MODEL
llm:
  provider: anthropic
  model: $MODEL
fact_extraction:
  enabled: false
ingestion:
  staging: false
server:
  port: $PORT
  auth_token: null
daemon:
  pid_file: ./wotw-daemon.pid
  lock_file: ./wotw-daemon.lock
  log_file: ./wotw-daemon.log
  log_level: info
provenance:
  enabled: true
  chain_file: provenance-chain.jsonl
EOF

LOG="$VAULT/run.log"
( cd "$VAULT" && node "$CLI" start --foreground --auto-approve >"$LOG" 2>&1 ) &
DAEMON_BASH=$!

cleanup() {
  ( cd "$VAULT" && node "$CLI" stop >/dev/null 2>&1 ) || true
  [ -f "$VAULT/wotw-daemon.pid" ] && kill "$(cat "$VAULT/wotw-daemon.pid")" 2>/dev/null || true
  kill "$DAEMON_BASH" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for the daemon to be ready.
for _ in $(seq 1 60); do grep -q "watcher ready" "$LOG" 2>/dev/null && break; sleep 1; done

batch_count() {
  # grep -c prints "0" to stdout AND exits 1 when there are no matches; capture
  # stdout only and never let the non-zero exit double the value.
  local n; n=$(grep -c 'batch complete' "$LOG" 2>/dev/null) || true
  printf '%s' "${n:-0}"
}

wait_for_batches() {
  local want="$1" deadline=$(( SECONDS + TIMEOUT ))
  while [ "$(batch_count)" -lt "$want" ]; do
    if grep -qiE 'dead.letter|FATAL|uncaught|unhandled' "$LOG" 2>/dev/null; then
      echo "PARITY_RUN_ERROR: error marker in log"; return 1
    fi
    [ "$SECONDS" -ge "$deadline" ] && { echo "PARITY_RUN_TIMEOUT"; return 1; }
    sleep 2
  done
}

# Batch 1: initial ingestion.
cp "$RAW"/*.md "$VAULT/raw/"
wait_for_batches 1 || { echo "=== LOG TAIL ==="; tail -20 "$LOG"; exit 1; }

# Batch 2 (optional): edit-existing-page.
if [ -n "$EDIT_RAW" ]; then
  cp "$EDIT_RAW"/*.md "$VAULT/raw/"
  wait_for_batches 2 || { echo "=== LOG TAIL ==="; tail -20 "$LOG"; exit 1; }
fi

echo "=== WIKI PAGES ==="
find "$VAULT/wiki/wiki" -type f -name '*.md' | sort | sed "s#$VAULT/wiki/##"
echo "=== PAGE COUNT ==="
find "$VAULT/wiki/wiki" -type f -name '*.md' | wc -l
echo "=== PROVENANCE RECORD TYPES ==="
grep -o '"type":"[a-z_]*"' "$VAULT/wiki/provenance-chain.jsonl" 2>/dev/null | sort | uniq -c || echo "(none)"
echo "=== DEAD LETTERS ==="
if [ -s "$VAULT/wiki/.wotw/failed-batches.jsonl" ]; then cat "$VAULT/wiki/.wotw/failed-batches.jsonl"; else echo "0 (clean)"; fi
echo "=== BATCHES COMPLETE ==="
batch_count; echo
