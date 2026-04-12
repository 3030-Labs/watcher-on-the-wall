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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { errMsg } from "../utils/errors.js";
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
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: `Internal error: ${errMsg(err)}` },
            id: null,
          }),
        );
      }
      await cleanup();
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
