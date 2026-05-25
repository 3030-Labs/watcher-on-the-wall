/**
 * MCP server subsystem. Owns an HTTP server (node:http) and creates a
 * fresh McpServer + StreamableHTTPServerTransport per request.
 *
 * Why a fresh transport per request? The MCP SDK's streamable HTTP transport
 * enforces a hard invariant in stateless mode (`sessionIdGenerator: undefined`):
 * the transport cannot be reused across requests, because message IDs would
 * collide between concurrent clients. The SDK throws the moment you hand the
 * same transport a second request. To support multiple CLI clients hitting
 * the daemon concurrently we therefore construct the MCP server fresh for
 * each /mcp call. All the heavy state (wiki store, search index, query
 * engine, cost tracker) is shared across those short-lived McpServer
 * instances via the ToolRegistrationContext.
 */
import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { safeFetchToFile, SafeFetchError } from "./safe-fetch.js";

/**
 * Constant-time string comparison. Throws-on-length-mismatch in
 * timingSafeEqual is itself a timing oracle; we normalize lengths
 * to a fixed buffer first.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) {
    // Burn fixed time regardless to avoid length-oracle.
    try {
      timingSafeEqual(Buffer.from(a.padEnd(64, "\0")), Buffer.from(b.padEnd(64, "\0")));
    } catch {
      /* ignore */
    }
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getLogger } from "../utils/logger.js";
import type { DaemonSubsystem } from "../daemon/index.js";
import type { RuntimeMode, WotwConfig } from "../utils/types.js";
import { VERSION } from "../utils/version.js";
import type { WikiStore } from "../wiki/store.js";
import type { IndexManager } from "../wiki/index-manager.js";
import type { WikiSearch } from "../wiki/search.js";
import type { CostTracker } from "../ingestion/cost-tracker.js";
import type { DeadLetterQueue } from "../ingestion/dead-letter.js";
import type { ModelRouter } from "../ingestion/model-router.js";
import type { ProvenanceChain } from "../provenance/chain.js";
import type { CompoundingEngine } from "../compounding/engine.js";
import { TokenStore } from "../multi-user/token-store.js";
import { QueryEngine } from "./query-engine.js";
import { registerTools } from "./tools.js";
import { registerResources } from "./resources.js";
import { RateLimiter, runMiddleware } from "./middleware.js";
import { loadAllPages } from "../ingestion/wiki-writer.js";
import { ProgressiveCache } from "./progressive-cache.js";
import type { FactStore } from "../facts/store.js";
import type { FactIndex } from "../facts/index-manager.js";

export interface McpServerOptions {
  config: WotwConfig;
  store: WikiStore;
  indexManager: IndexManager;
  search: WikiSearch;
  costTracker: CostTracker;
  modelRouter: ModelRouter;
  provenance?: ProvenanceChain | null;
  compounding?: CompoundingEngine | null;
  /**
   * Resolved runtime mode. Forwarded to the internal QueryEngine so that
   * MCP query tool calls dispatch through the CLI binary in CLI mode.
   */
  runtimeMode?: RuntimeMode;
  /**
   * Optional dead-letter sink. Exposed through `get_stats` so MCP clients
   * can see the count of permanently-failed batches.
   */
  deadLetter?: DeadLetterQueue | null;
  /**
   * Pass B fact-extraction sidecar. When both are provided, the daemon
   * registers `query_facts` and routes the Group A tools (define /
   * relate / cite_sources) through the fact layer first.
   */
  factStore?: FactStore | null;
  factIndex?: FactIndex | null;
}

/**
 * Daemon subsystem that wraps an MCP server bound to an HTTP transport.
 */
export class McpHttpServer implements DaemonSubsystem {
  readonly name = "mcp-server";
  private readonly opts: McpServerOptions;
  private httpServer: HttpServer | null = null;
  private limiter: RateLimiter;
  private queryEngine: QueryEngine;
  private tokenStore: TokenStore | null = null;
  /**
   * Continuation cache for `query_progressive` / `query_expand`. Lives on
   * the long-lived McpHttpServer (not per-request) so a client's tier-0
   * call and follow-up tier-1 expand call hit the same cache, even though
   * each /mcp request constructs a fresh McpServer instance.
   */
  private progressiveCache: ProgressiveCache;
  /** Set of in-flight transports so we can clean up on shutdown. */
  private inFlight: Set<StreamableHTTPServerTransport> = new Set();

  constructor(opts: McpServerOptions) {
    this.opts = opts;
    this.limiter = new RateLimiter(opts.config.server.rate_limit_rpm);
    this.queryEngine = new QueryEngine({
      config: opts.config,
      store: opts.store,
      search: opts.search,
      costTracker: opts.costTracker,
      modelRouter: opts.modelRouter,
      provenance: opts.provenance ?? null,
      runtimeMode: opts.runtimeMode,
    });
    this.progressiveCache = new ProgressiveCache();
    if (opts.config.multi_user.enabled) {
      this.tokenStore = new TokenStore({
        workspacesDir: opts.config.multi_user.workspaces_dir,
      });
      this.tokenStore.load();
    }
  }

  /** Expose the token store for CLI admin commands. */
  getTokenStore(): TokenStore | null {
    return this.tokenStore;
  }

  async start(): Promise<void> {
    const log = getLogger("mcp-server");
    const {
      host,
      port,
      auth_token: authToken,
      rate_limit_rpm: rateLimit,
    } = this.opts.config.server;
    if (this.tokenStore) {
      log.info({ users: this.tokenStore.size() }, "multi-user mode enabled");
    }

    // M-SEC-2: When BOTH auth paths are disabled (no single-token and no
    // multi-user token store), the server accepts every request. That is
    // documented as intentional for a trusted localhost-only setup, but:
    //   (a) it deserves a loud WARN banner at startup so the operator
    //       knows they are running with no authentication, and
    //   (b) we must refuse to start at all if the operator has also
    //       bound the server to a non-loopback address. Exposing an
    //       unauthenticated wiki to the LAN by silently combining those
    //       two config options would be a footgun.
    const authDisabled = !authToken && !this.tokenStore;
    if (authDisabled) {
      const isLoopback = isLoopbackHost(host);
      if (!isLoopback) {
        const msg =
          `refusing to start mcp server: auth is disabled ` +
          `(server.auth_token is unset and multi_user.enabled is false) ` +
          `but server.host is "${host}", which is not a loopback address. ` +
          `Either (1) set server.auth_token to a secret value, ` +
          `(2) enable multi_user and create tokens with \`wotw user add\`, ` +
          `or (3) bind to 127.0.0.1 / ::1 if you truly want a no-auth server. ` +
          `See docs/mcp-tools.md for the trade-offs.`;
        log.error({ host }, msg);
        throw new Error(msg);
      }
      log.warn(
        { host, port },
        "⚠️  MCP SERVER IS UNAUTHENTICATED. " +
          "server.auth_token is unset and multi_user.enabled is false — " +
          "any process that can reach this loopback address can read your " +
          "wiki without credentials. Set server.auth_token or enable " +
          "multi_user to require a bearer token.",
      );
    }

    this.httpServer = createServer((req, res) => {
      // Fire-and-forget: errors are handled inside handleRequest.
      void this.handleRequest(req, res, { authToken, rateLimit }).catch((err) => {
        log.error({ err, url: req.url }, "unhandled request error");
        if (!res.headersSent) {
          try {
            res.writeHead(500, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "internal error" }));
          } catch {
            /* socket already torn down */
          }
        }
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer?.once("error", reject);
      this.httpServer?.listen(port, host, () => {
        this.httpServer?.off("error", reject);
        log.info({ host, port }, "mcp server listening");
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const log = getLogger("mcp-server");
    log.info("stopping mcp server");
    // Close any in-flight transports so their sockets unblock.
    for (const t of this.inFlight) {
      try {
        await t.close();
      } catch {
        /* ignore */
      }
    }
    this.inFlight.clear();
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer?.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  /** Expose the query engine so other callers can reuse it. */
  getQueryEngine(): QueryEngine {
    return this.queryEngine;
  }

  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    opts: { authToken: string | null; rateLimit: number },
  ): Promise<void> {
    const log = getLogger("mcp-server");
    // Route: /healthz, /mcp, else 404.
    if (!req.url) {
      res.writeHead(404).end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host ?? "127.0.0.1"}`);
    if (url.pathname === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, name: "watcher-on-the-wall", version: VERSION }));
      return;
    }
    // Internal admin endpoints — hosted mode only
    if (url.pathname.startsWith("/internal/")) {
      await this.handleInternalRequest(url.pathname, req, res);
      return;
    }
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }

    const mw = runMiddleware(
      req,
      res,
      {
        authToken: opts.authToken,
        tokenStore: this.tokenStore,
        rateLimitRpm: opts.rateLimit,
        trustProxy: this.opts.config.server.trust_proxy,
      },
      this.limiter,
    );
    if (!mw.ok) return;
    // Attach principal for downstream visibility (e.g. provenance metadata).
    // Currently advisory only; tool implementations can read it via the
    // context registered for this request if they care.
    if (mw.principal) {
      log.debug({ user: mw.principal.user }, "authenticated request");
    }

    // Parse body once, then hand it to the transport as a pre-parsed body
    // (the SDK accepts this to avoid double-reading the request stream).
    let body: unknown = undefined;
    if (req.method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        log.warn({ err }, "failed to parse request body");
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "Parse error" },
            id: null,
          }),
        );
        return;
      }
    }

    // Build a fresh McpServer + Transport for this single request.
    // This is mandatory in stateless mode — the SDK throws on reuse.
    const mcpServer = new McpServer(
      { name: "watcher-on-the-wall", version: VERSION },
      { capabilities: { tools: {}, resources: {} } },
    );
    registerTools(mcpServer, {
      config: this.opts.config,
      store: this.opts.store,
      indexManager: this.opts.indexManager,
      search: this.opts.search,
      queryEngine: this.queryEngine,
      costTracker: this.opts.costTracker,
      provenance: this.opts.provenance ?? null,
      compounding: this.opts.compounding ?? null,
      deadLetter: this.opts.deadLetter ?? null,
      progressiveCache: this.progressiveCache,
      factStore: this.opts.factStore ?? null,
      factIndex: this.opts.factIndex ?? null,
    });
    registerResources(mcpServer, {
      config: this.opts.config,
      indexManager: this.opts.indexManager,
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    this.inFlight.add(transport);

    // Ensure cleanup when the connection ends, regardless of path taken.
    const cleanup = async (): Promise<void> => {
      this.inFlight.delete(transport);
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      try {
        await mcpServer.close();
      } catch {
        /* ignore */
      }
    };
    res.on("close", () => {
      void cleanup();
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      log.error({ err, method: req.method, url: req.url }, "mcp request failed");
      if (!res.headersSent) {
        // Review item 54: don't embed errMsg(err) in the JSON-RPC error
        // message. SDK error shapes can carry headers / paths / tokens
        // that leak via the response body. Log the structured detail;
        // return a generic message.
        log.error({ err }, "MCP request failed");
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      }
      await cleanup();
    }
  }

  /**
   * Handle /internal/* admin endpoints. These are only useful in hosted
   * mode — they let the cloud control plane inspect queue state, trigger
   * index rebuilds, health checks, export/import. Authenticated via
   * x-admin-key header matching ADMIN_SERVICE_KEY env var.
   */
  private async handleInternalRequest(
    pathname: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const log = getLogger("internal-api");
    // Review items 50 + 59: prefer the dedicated internal-admin secret
    // (rip-and-replace per G4 with tenant_count=0); fall back to
    // ADMIN_SERVICE_KEY only while wotw-cloud is being migrated to the
    // split-secret scheme. Compare in constant time to close the timing
    // oracle the original `!==` opened (item 59).
    const adminKey = process.env.WOTW_INTERNAL_ADMIN_KEY ?? process.env.ADMIN_SERVICE_KEY;
    const providedRaw = req.headers["x-admin-key"];
    const providedKey = typeof providedRaw === "string" ? providedRaw : "";
    if (!adminKey || !constantTimeEqual(providedKey, adminKey)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Parse JSON body for POST requests
    let body: Record<string, unknown> = {};
    if (req.method === "POST") {
      try {
        body = (await readJsonBody(req)) as Record<string, unknown>;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid JSON body" }));
        return;
      }
    }

    const json = (status: number, data: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    // Review item 55: every /internal/* endpoint accepted body.tenant_id
    // and trusted it for logging/routing without verifying it matches
    // the daemon's own config.hosted.tenant_id. A misrouted control-
    // plane call would execute against the wrong tenant. Verify once
    // here so downstream handlers can trust body.tenant_id.
    const expectedTenant = this.opts.config.hosted.tenant_id;
    const providedTenant = typeof body.tenant_id === "string" ? body.tenant_id : null;
    if (providedTenant !== null && expectedTenant !== null && providedTenant !== expectedTenant) {
      log.warn(
        { providedTenant, expectedTenant, pathname },
        "internal: rejected tenant_id mismatch",
      );
      json(403, { error: "tenant_id mismatch" });
      return;
    }

    try {
      switch (pathname) {
        case "/internal/queue-status": {
          // Only meaningful if TenantScheduler is active (import at queue level)
          json(200, {
            note: "queue-status available when hosted mode is active",
            hosted: this.opts.config.hosted.enabled,
          });
          break;
        }

        case "/internal/rebuild-index": {
          log.info({ tenantId: body.tenant_id }, "rebuilding search index");
          const startMs = Date.now();
          const pages = await loadAllPages(this.opts.store);
          this.opts.search.rebuild(pages);
          const duration = Date.now() - startMs;
          json(200, { pages_indexed: pages.length, duration_ms: duration });
          break;
        }

        case "/internal/health-check": {
          log.info({ tenantId: body.tenant_id }, "running health check");
          const allPages = await loadAllPages(this.opts.store);
          const orphaned = allPages.filter((p) => p.frontmatter?.status === "orphaned").length;

          json(200, {
            total_pages: allPages.length,
            orphaned_pages: orphaned,
            tenant_id: body.tenant_id,
          });
          break;
        }

        case "/internal/verify": {
          // G5 closure (Pass 018, v0.8.2): full provenance chain verify.
          // Walks every record; recomputes id + chain_hash; validates
          // HMAC via KeyStore lookup (or 4-tier fallback for pre-v0.8.2
          // records). Returns the same VerificationResult shape that
          // ProvenanceChain.verify() produces. Surface contract frozen
          // for the future wotw-verify Go CLI (CT5.01, separate pass).
          //
          // Errors are returned in the body (200 with ok:false), not as
          // HTTP errors — a "the chain is broken" response is still a
          // successful call to the endpoint. HTTP 503 only if provenance
          // is disabled / unavailable on this daemon.
          if (!this.opts.provenance) {
            json(503, {
              error: "provenance_disabled",
              note: "this daemon has provenance.enabled=false",
            });
            break;
          }
          log.info({ tenantId: body.tenant_id }, "running provenance chain verify");
          const startMs = Date.now();
          const result = await this.opts.provenance.verify();
          const durationMs = Date.now() - startMs;
          json(200, {
            ok: result.ok,
            total_records: result.totalRecords,
            verified_records: result.verifiedRecords,
            errors: result.errors,
            duration_ms: durationMs,
          });
          break;
        }

        case "/internal/export": {
          // Review item 56: pre-fix returned 200 "acknowledged" but did
          // NO work. A control plane that trusts the response would mark
          // the tenant exported when no export happened. Return 501 so
          // callers cannot mistake a stub for a completed export.
          log.warn({ tenantId: body.tenant_id }, "export requested — not implemented");
          json(501, {
            error: "not_implemented",
            note: "tenant export is performed by the wotw-cloud layer, not the daemon",
          });
          break;
        }

        case "/internal/import": {
          // Review item 56: same shape as /internal/export — pre-fix
          // returned 200 with no work. 501 so callers cannot mistake a
          // stub for a completed restore. Body fields (backup_path)
          // are explicitly NOT echoed in the response (X4 footnote on
          // S8-F-006).
          log.warn({ tenantId: body.tenant_id }, "import requested — not implemented");
          json(501, {
            error: "not_implemented",
            note: "tenant import is performed by the wotw-cloud layer, not the daemon",
          });
          break;
        }

        case "/internal/ingest": {
          // Pass 012 — file-upload → daemon-ingestion sync.
          //
          // wotw-cloud's /api/sources/trigger-ingest POSTs here after a user
          // uploads a file to Supabase Storage. We download the file from
          // the signed URL into the configured raw_path; chokidar then
          // picks it up via the existing FileWatcher → IngestionQueue
          // pipeline, which writes provenance records that cloud-sink
          // mirrors back to Supabase (Pass 010 work). Cloud-side maps
          // source_files → raw_source_id via the filename prefix.
          //
          // Fire-and-forget shape: this endpoint returns 202 once the file
          // is on disk and chokidar can see it. Ingestion completion is
          // signaled asynchronously via the provenance sink.
          const rawSourceId = body.raw_source_id;
          const signedUrl = body.signed_url;
          const filename = body.filename;
          if (typeof rawSourceId !== "string" || !rawSourceId) {
            json(400, { error: "raw_source_id required" });
            break;
          }
          // Review item 57: length + charset bounds on raw_source_id +
          // filename so filesystem NAME_MAX truncation can't collide
          // distinct uploads onto the same on-disk name, and Unicode
          // normalization can't smuggle a `../` past the basename check.
          if (rawSourceId.length > 64 || !/^[a-zA-Z0-9_-]+$/.test(rawSourceId)) {
            json(400, { error: "raw_source_id must be ≤64 chars [A-Za-z0-9_-]" });
            break;
          }
          if (typeof signedUrl !== "string" || !signedUrl.startsWith("https://")) {
            json(400, { error: "signed_url required (must be https://...)" });
            break;
          }
          if (typeof filename !== "string" || !filename) {
            json(400, { error: "filename required" });
            break;
          }
          // Review item 57: bound filename to avoid NAME_MAX truncation
          // collision (most Linux fs's truncate at 255 bytes). Allow
          // common printable ASCII but reject control chars + slashes.
          if (filename.length > 200) {
            json(400, { error: "filename must be ≤200 chars" });
            break;
          }
          // eslint-disable-next-line no-control-regex
          if (/[\x00-\x1f\x7f]/.test(filename)) {
            json(400, { error: "filename must not contain control characters" });
            break;
          }
          // Disallow path separators / traversal in filename.
          if (
            filename.includes("/") ||
            filename.includes("\\") ||
            filename.includes("..") ||
            filename.startsWith(".")
          ) {
            json(400, { error: "filename must be a clean basename" });
            break;
          }

          const rawPath = this.opts.config.raw_path;
          // Prefix the raw_source_id so the cloud-sink can map provenance
          // records' source_files back to the originating raw_sources row.
          const targetName = `${rawSourceId}-${filename}`;
          const resolvedRawPath = resolve(rawPath);
          const targetPath = resolve(join(resolvedRawPath, targetName));
          // Defense-in-depth: ensure the resolved target lives inside raw_path.
          if (targetPath !== resolvedRawPath && !targetPath.startsWith(resolvedRawPath + sep)) {
            json(400, { error: "target path escapes raw_path" });
            break;
          }

          // Pre-create the parent directory so safeFetchToFile can stream
          // straight into it.
          try {
            await mkdir(dirname(targetPath), { recursive: true });
          } catch (err) {
            log.error(
              { err: err instanceof Error ? err.message : String(err), rawSourceId },
              "ingest: mkdir failed",
            );
            json(500, { error: "internal" });
            break;
          }

          try {
            // SSRF-hardened fetch (review items 49 + 52 + 53 + 58).
            // Layered defenses per X4-C-1: hostname allowlist + DNS
            // private-IP rejection + content-length cap + streaming with
            // byte-count cap + redirect:"error" + AbortSignal timeout.
            const result = await safeFetchToFile(signedUrl, {
              targetPath,
              timeoutMs: 30_000,
              maxBytes: 32 * 1024 * 1024,
              // Supabase Storage and S3 presigned URLs are the only
              // upstream sources the daemon trusts. The allowlist is
              // substring-matched to cover storage.<project>.supabase.co,
              // <bucket>.s3.<region>.amazonaws.com, and the
              // amazonaws.com host shape S3 presigned URLs use.
              hostnameAllowlist: [".supabase.co", ".s3.amazonaws.com", ".amazonaws.com"],
            });
            log.info(
              {
                rawSourceId,
                filename,
                bytes: result.bytes,
                contentType: result.contentType,
                targetName,
              },
              "ingest: file landed in raw_path",
            );
            json(202, {
              status: "accepted",
              raw_source_id: rawSourceId,
              target_name: targetName,
              bytes: result.bytes,
            });
          } catch (err) {
            // Never echo internal hostnames / paths / upstream errors
            // back to the caller — they're a path/host enumeration
            // oracle (review item 53). Log the structured detail; return
            // a code-only error to the caller.
            const code = err instanceof SafeFetchError ? err.code : "WRITE_FAILED";
            log.warn(
              {
                rawSourceId,
                filename,
                code,
                err: err instanceof Error ? err.message : String(err),
              },
              "ingest: download rejected",
            );
            const status =
              code === "UPSTREAM_NON_2XX"
                ? 502
                : code === "FETCH_TIMEOUT"
                  ? 504
                  : code === "PRIVATE_IP_BLOCKED" ||
                      code === "HOSTNAME_NOT_ALLOWED" ||
                      code === "INVALID_URL" ||
                      code === "INVALID_SCHEME"
                    ? 400
                    : code === "CONTENT_LENGTH_TOO_LARGE" || code === "CONTENT_LENGTH_DURING_STREAM"
                      ? 413
                      : code === "CONTENT_TYPE_NOT_ALLOWED"
                        ? 415
                        : 500;
            json(status, { error: "ingest_rejected", code });
          }
          break;
        }

        default: {
          json(404, { error: `unknown internal endpoint: ${pathname}` });
        }
      }
    } catch (err) {
      log.error({ err, pathname }, "internal endpoint error");
      json(500, { error: "internal error" });
    }
  }
}

/**
 * True if `host` is a loopback address / hostname. Used by the M-SEC-2
 * refuse-to-start check. We only accept the canonical loopback forms;
 * anything else (including `0.0.0.0`, LAN IPs, public IPs, or random
 * hostnames) is treated as externally reachable.
 */
function isLoopbackHost(host: string): boolean {
  if (host === "127.0.0.1") return true;
  if (host === "::1") return true;
  if (host === "localhost") return true;
  // `127.0.0.0/8` is all loopback on most platforms.
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  return false;
}

/** Read a JSON request body (up to 4MB). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 4 * 1024 * 1024;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve(undefined);
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

export { QueryEngine } from "./query-engine.js";
export { registerTools } from "./tools.js";
export { registerResources } from "./resources.js";
