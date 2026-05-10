#!/bin/sh
# Entrypoint for the wotw daemon image.
#
# As of Pass 006, the daemon reads hosted-mode settings directly from env
# vars via applyEnvOverrides() in src/daemon/config.ts. This entrypoint
# preflights the env, ensures the wiki root exists and is writable, then
# exec's the daemon's child-process entrypoint (`dist/daemon/entry.js`)
# which attaches all subsystems (wiki store, search, ingestion, watcher,
# McpHttpServer, lintScheduler) before running.
#
# IMPORTANT: do NOT use `wotw start --foreground` here. That CLI path
# currently runs Daemon.init() + Daemon.run() *without* attaching any
# subsystems, so the process stays alive but never binds the HTTP port
# (TCP 3000 returns "connection refused"). Surfaced 2026-05-10 during
# Step 5 BYOK live verification.
#
# Required env (when WOTW_HOSTED=true):
#   TENANT_ID            tenant UUID (becomes hosted.tenant_id)
#   ANTHROPIC_API_KEY    Anthropic API key (decrypted at spawn by the orchestrator)
#   WIKI_ROOT            absolute path under /data (e.g. /data/<tenant_id>)
#
# Optional env (forwarded to the daemon as-is):
#   WOTW_HOSTED          "true" to enable hosted mode (default true in this image)
#   WOTW_PORT            HTTP port (default 3000)
#   WOTW_HOST            bind host (default 0.0.0.0)
#   WOTW_LOG_LEVEL       pino level (default "info")
#   WOTW_RUNTIME_MODE    "auto" | "cli" | "api" (default "api")
#   WOTW_PLAN            "founding" | "pro"
#   WOTW_TIMEZONE        IANA timezone
#   ADMIN_SERVICE_KEY    sets server.auth_token so the cloud control plane
#                        can reach /mcp + /internal/*

set -eu

WOTW_HOSTED="${WOTW_HOSTED:-true}"
export WOTW_HOSTED

if [ "${WOTW_HOSTED}" = "true" ]; then
  if [ -z "${TENANT_ID:-}" ]; then
    echo "FATAL: TENANT_ID env var is required when WOTW_HOSTED=true" >&2
    exit 78
  fi
  if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
    echo "FATAL: ANTHROPIC_API_KEY env var is required when WOTW_HOSTED=true" >&2
    exit 78
  fi
  if [ -z "${WIKI_ROOT:-}" ]; then
    echo "FATAL: WIKI_ROOT env var is required when WOTW_HOSTED=true" >&2
    exit 78
  fi
fi

# Ensure wiki root exists. The daemon's WikiStore.ensureLayout creates
# subdirs but expects the root itself to be writable.
mkdir -p "${WIKI_ROOT}" "${WIKI_ROOT}/raw" "${WIKI_ROOT}/.wotw"
if [ ! -w "${WIKI_ROOT}" ]; then
  echo "FATAL: WIKI_ROOT ${WIKI_ROOT} is not writable" >&2
  exit 78
fi

# cd into WIKI_ROOT so the daemon's pid/lock/log files (defaulting to
# `~/.wotw/...` paths or relative to cwd) land under the persistent volume.
cd "${WIKI_ROOT}"

# exec replaces this shell so signals (SIGTERM from Fly) reach the daemon
# directly. The entry script attaches all subsystems including the
# McpHttpServer that owns the /healthz + /mcp endpoints.
exec node /app/dist/daemon/entry.js
