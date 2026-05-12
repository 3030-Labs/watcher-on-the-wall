# wotw daemon image
#
# Self-contained build. Produces a runnable image that boots the wotw daemon
# in hosted mode. Designed for per-tenant Fly Machine deployment but also
# usable in any container runtime that respects standard Docker conventions.
#
# Build:
#   docker build -t wotw .
#
# Run (hosted mode):
#   docker run --rm \
#     -e TENANT_ID=<uuid> \
#     -e ANTHROPIC_API_KEY=<key> \
#     -e WIKI_ROOT=/data/<uuid> \
#     -e ADMIN_SERVICE_KEY=<token> \
#     -v wotw-data:/data \
#     -p 3000:3000 \
#     wotw
FROM node:20-slim AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@10.13.1

WORKDIR /app

# Lockfiles first for layer cache friendliness.
COPY package.json pnpm-lock.yaml ./

# --ignore-scripts: skip husky's `prepare` which expects a git repo. Build
# scripts are run explicitly below.
RUN pnpm install --frozen-lockfile --ignore-scripts

# Run @anthropic-ai/claude-code's postinstall manually. The package ships a
# launcher script at node_modules/.bin/claude that needs a platform-native
# binary, which the postinstall fetches. We skipped postinstall above via
# --ignore-scripts (needed to avoid husky's `prepare` failing in CI), so
# claude-code's native binary install must be invoked explicitly here.
# Without this step the daemon's agent SDK can spawn the launcher but the
# launcher exits 1 with "claude native binary not installed." Validation-gap
# instance #9 surfaced this during Pass 009 Step 7B verification.
RUN node /app/node_modules/@anthropic-ai/claude-code/install.cjs

# Copy the rest of the repo. .dockerignore drops node_modules, dist, tests,
# docs, etc. so this layer is small.
COPY . .

# Build TypeScript -> dist/ and prune dev deps.
# --ignore-scripts on prune for the same reason it's used on install above:
# pnpm runs the `prepare` lifecycle after the prune, but devDependencies
# (husky) have just been removed, so `prepare: husky` would fail with
# "husky: not found".
RUN pnpm build \
 && pnpm prune --prod --ignore-scripts

FROM node:20-slim AS runtime

# git: daemon's git-committer subsystem. ca-certificates: HTTPS fetches.
# gosu: entrypoint-time privilege drop (the daemon must run as non-root; see
# the user-create + chown blocks below and the entrypoint script for details).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates gosu \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 1001 wotw \
 && useradd -m -u 1001 -g wotw -s /bin/sh wotw

WORKDIR /app

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/src/wiki/templates /app/src/wiki/templates

# Sanity check that the claude CLI native binary survived the multi-stage
# copy (it was installed in the build stage; node_modules is COPY'd into
# the runtime stage so the binary lives at the same path). The --version
# invocation does not include --dangerously-skip-permissions, so the CLI's
# root-check (instance #11) does not fire even though this RUN executes as
# root during build.
RUN /app/node_modules/.bin/claude --version

# Runtime entrypoint: chowns /data and drops to wotw via gosu, then bridges
# container env vars into a wotw.yaml.
COPY docker/entrypoint.sh /usr/local/bin/wotw-entrypoint
RUN chmod +x /usr/local/bin/wotw-entrypoint

# Symlink the wotw binary so the entrypoint can invoke it without a relative
# path. The shebang on dist/cli/index.js handles the Node invocation.
RUN chmod +x /app/dist/cli/index.js \
 && ln -s /app/dist/cli/index.js /usr/local/bin/wotw

# Chown /app to the wotw user. Must come AFTER all writes to /app are
# complete in this stage. The daemon process (running as wotw) needs read +
# execute on its own dist/ and node_modules/, including the claude-code
# launcher at node_modules/.bin/claude.
RUN chown -R wotw:wotw /app

# /data is the wiki root volume. Per-tenant deployments mount a Fly volume here.
VOLUME ["/data"]

# Sensible defaults; the orchestrator overrides via env.
#
# WOTW_HOST=:: binds to IPv6 dual-stack (Node.js default). This accepts BOTH
# IPv6 (required for Fly 6PN cross-machine traffic — wotw-cloud reaches the
# daemon via `<machine_id>.vm.<app>.internal` which resolves to an IPv6 addr
# in the fdaa::/16 range) AND IPv4 (required for Fly's local healthcheck
# which probes 127.0.0.1:3000 from inside the machine's own netns).
#
# Earlier default `WOTW_HOST=0.0.0.0` was IPv4-only — local healthcheck
# passed but cross-machine 6PN fetches got ECONNREFUSED. Surfaced as
# validation-gap instance #8 during Pass 009 Step 4 (the first time cross-
# machine traffic to the daemon was actually exercised). v0.2.2 fix.
ENV WOTW_HOSTED=true \
    WOTW_PORT=3000 \
    WOTW_HOST=:: \
    WOTW_RUNTIME_MODE=api \
    WOTW_LOG_LEVEL=info \
    NODE_ENV=production

EXPOSE 3000

# No USER directive — entrypoint runs as root long enough to chown the Fly
# volume mount at /data (volumes arrive root-owned), then exec's gosu wotw to
# drop privileges before invoking the daemon. USER here would prevent the
# chown from succeeding.
CMD ["/usr/local/bin/wotw-entrypoint"]
