/**
 * Small MCP client used by CLI commands to talk to the daemon over HTTP.
 * Uses the SDK's StreamableHTTPClientTransport so our format stays in sync
 * with whatever version of the spec the server is using.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { VERSION } from "../../../utils/version.js";

export interface McpCallOptions {
  host: string;
  port: number;
  authToken: string | null;
  tool: string;
  args: Record<string, unknown>;
  /**
   * Per-request timeout in milliseconds. Defaults to 60s which is fine for
   * interactive queries; long-running tools like `synthesize` should pass a
   * larger value (e.g. 10 minutes).
   */
  timeoutMs?: number;
}

/**
 * Connect to the daemon's MCP server, call a tool, and return the result.
 */
export async function callMcpTool(opts: McpCallOptions): Promise<unknown> {
  const url = new URL(`http://${opts.host}:${opts.port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: opts.authToken
      ? { headers: { authorization: `Bearer ${opts.authToken}` } }
      : undefined,
  });
  const client = new Client({ name: "wotw-cli", version: VERSION }, { capabilities: {} });
  try {
    await client.connect(transport);
    const result = await client.callTool(
      { name: opts.tool, arguments: opts.args },
      undefined,
      opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    );
    return result;
  } finally {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  }
}
