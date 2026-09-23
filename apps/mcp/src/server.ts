import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { ToolCallContext } from './context.js';
import type { McpToolDeps } from './deps.js';
import { getEntityProvenanceTool } from './tools/get-entity-provenance.js';
import { getFactProvenanceTool } from './tools/get-fact-provenance.js';
import { getGraphTool } from './tools/get-graph.js';
import { listFactsTool } from './tools/list-facts.js';
import { searchContextTool } from './tools/search-context.js';
import { wrapToolHandler } from './tool.js';

/**
 * Builds an MCP server bound to one caller's identity + one engagement for
 * the life of a single agentic question — the internal, in-process transport
 * (`apps/api`'s `agentic-qa.service.ts` connects to it over
 * `InMemoryTransport.createLinkedPair()`). Tool input schemas never include
 * `tenantId`/`userId`/`engagementId`: they're closed over here from an
 * already-authenticated caller, never supplied by the model, which
 * forecloses a prompt-injected cross-engagement tool call.
 *
 * An external-facing build (a different transport, `engagementId` as an
 * explicit, authz-revalidated tool input) is a fast-follow that reuses these
 * same tool definitions and handlers — see `docs/architecture.md`'s MCP
 * milestone — not a rewrite.
 */
export function createMcpServer(deps: McpToolDeps, ctx: ToolCallContext): McpServer {
  const server = new McpServer({ name: 'ai-de', version: '0.0.0' });

  server.registerTool(
    searchContextTool.name,
    { description: searchContextTool.description, inputSchema: searchContextTool.inputSchema },
    wrapToolHandler<typeof searchContextTool.inputSchema>(ctx, deps, searchContextTool.handler),
  );
  server.registerTool(
    listFactsTool.name,
    { description: listFactsTool.description, inputSchema: listFactsTool.inputSchema },
    wrapToolHandler<typeof listFactsTool.inputSchema>(ctx, deps, listFactsTool.handler),
  );
  server.registerTool(
    getFactProvenanceTool.name,
    {
      description: getFactProvenanceTool.description,
      inputSchema: getFactProvenanceTool.inputSchema,
    },
    wrapToolHandler<typeof getFactProvenanceTool.inputSchema>(
      ctx,
      deps,
      getFactProvenanceTool.handler,
    ),
  );
  server.registerTool(
    getEntityProvenanceTool.name,
    {
      description: getEntityProvenanceTool.description,
      inputSchema: getEntityProvenanceTool.inputSchema,
    },
    wrapToolHandler<typeof getEntityProvenanceTool.inputSchema>(
      ctx,
      deps,
      getEntityProvenanceTool.handler,
    ),
  );
  server.registerTool(
    getGraphTool.name,
    { description: getGraphTool.description, inputSchema: getGraphTool.inputSchema },
    wrapToolHandler<typeof getGraphTool.inputSchema>(ctx, deps, getGraphTool.handler),
  );

  return server;
}
