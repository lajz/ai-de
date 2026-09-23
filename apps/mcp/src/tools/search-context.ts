import { z } from 'zod';

import type { McpToolDeps } from '../deps.js';
import type { ToolCallContext } from '../context.js';

const inputSchema = {
  query: z
    .string()
    .min(1)
    .describe(
      'The question or topic to search for in this engagement’s retrieved facts and quotes.',
    ),
};

export const searchContextTool = {
  name: 'search_context',
  description:
    'Semantic search over this engagement’s retrieved facts and source quotes. Returns matching ' +
    'context (fact summaries, quotes, source permalinks) — it does not answer the question itself. ' +
    'Call this to look something up before answering, or to follow up on a lead.',
  inputSchema,
  async handler(
    input: { query: z.infer<typeof inputSchema.query> },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) {
    return deps.runInContext(ctx, () => deps.retrieval.searchContext(input.query));
  },
};
