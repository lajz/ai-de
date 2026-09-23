import { z } from 'zod';

import type { McpToolDeps } from '../deps.js';
import type { ToolCallContext } from '../context.js';

const inputSchema = {
  limit: z.number().int().min(1).max(500).optional().describe('Page size, default 100, max 500.'),
  cursor: z.string().optional().describe('Opaque cursor from a previous page’s nextCursor.'),
};

export const listFactsTool = {
  name: 'list_facts',
  description:
    'This engagement’s recorded facts, newest first, each with its decrypted evidence citations. ' +
    'Keyset-paginated — pass the previous page’s cursor to page through.',
  inputSchema,
  async handler(
    input: {
      limit?: z.infer<typeof inputSchema.limit>;
      cursor?: z.infer<typeof inputSchema.cursor>;
    },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) {
    return deps.runInContext(ctx, () =>
      deps.retrieval.listFacts({ limit: input.limit, cursor: input.cursor }),
    );
  },
};
