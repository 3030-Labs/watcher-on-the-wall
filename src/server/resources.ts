/**
 * MCP resource registrations. Resources expose static URIs that clients
 * can read directly (not a tool call). We expose:
 *
 *   wiki://index   — the auto-generated wiki index markdown
 *   wiki://schema  — the project CLAUDE.md schema
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { join } from "node:path";
import { readTextOrNullAsync } from "../utils/fs.js";
import type { WotwConfig } from "../utils/types.js";
import type { IndexManager } from "../wiki/index-manager.js";

export interface ResourceRegistrationContext {
  config: WotwConfig;
  indexManager: IndexManager;
}

export function registerResources(server: McpServer, ctx: ResourceRegistrationContext): void {
  server.registerResource(
    "wiki-index",
    "wiki://index",
    {
      title: "Wiki Index",
      description: "The auto-generated catalog of every wiki page.",
      mimeType: "text/markdown",
    },
    async () => {
      const text = (await ctx.indexManager.read()) ?? "# Wiki Index\n\n_Not yet built._";
      return {
        contents: [
          {
            uri: "wiki://index",
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    },
  );

  server.registerResource(
    "wiki-schema",
    "wiki://schema",
    {
      title: "Wiki Schema (CLAUDE.md)",
      description: "The project's CLAUDE.md schema and ingestion conventions.",
      mimeType: "text/markdown",
    },
    async () => {
      const path = join(ctx.config.wiki_root, "CLAUDE.md");
      const text = (await readTextOrNullAsync(path)) ?? "# CLAUDE.md\n\n_Missing._";
      return {
        contents: [
          {
            uri: "wiki://schema",
            mimeType: "text/markdown",
            text,
          },
        ],
      };
    },
  );
}
