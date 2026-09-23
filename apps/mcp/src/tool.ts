import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';

import type { McpToolDeps } from './deps.js';
import type { ToolCallContext } from './context.js';

/**
 * Wraps a tool's typed business handler into an MCP `ToolCallback`: on
 * success, JSON-encodes the result as the tool's text content; on a thrown
 * error (an authz denial, a not-found, a bad request from the wrapped
 * `apps/api` service) returns `isError: true` with just `err.message` — never
 * a raw stack — so the model can see and react to the failure instead of the
 * whole agent loop turn crashing.
 */
export function wrapToolHandler<Shape extends z.ZodRawShape>(
  ctx: ToolCallContext,
  deps: McpToolDeps,
  handler: (
    input: { [K in keyof Shape]: z.infer<Shape[K]> },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) => Promise<unknown>,
): (input: { [K in keyof Shape]: z.infer<Shape[K]> }) => Promise<CallToolResult> {
  return async (input) => {
    try {
      const result = await handler(input, ctx, deps);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: errorMessage(err) }], isError: true };
    }
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'tool call failed';
}
