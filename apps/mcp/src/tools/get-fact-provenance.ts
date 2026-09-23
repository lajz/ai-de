import { z } from 'zod';

import type { McpToolDeps } from '../deps.js';
import type { ToolCallContext } from '../context.js';

const inputSchema = {
  factId: z.string().min(1).describe('The fact id to trace provenance for.'),
};

export const getFactProvenanceTool = {
  name: 'get_fact_provenance',
  description:
    'The full provenance chain for one fact: fact → evidence quotes → source → ACL → ' +
    'extraction run. Use this to verify a fact or check where it came from.',
  inputSchema,
  async handler(
    input: { factId: z.infer<typeof inputSchema.factId> },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) {
    return deps.runInContext(ctx, () => deps.lineage.getFactProvenance(input.factId));
  },
};
