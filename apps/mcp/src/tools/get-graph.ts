import { entityTypeSchema, predicateSchema } from '@fde/core';
import { type z } from 'zod';

import type { McpToolDeps } from '../deps.js';
import type { ToolCallContext } from '../context.js';

const inputSchema = {
  entityType: entityTypeSchema.optional().describe('Narrow the graph to one entity type.'),
  predicate: predicateSchema.optional().describe('Narrow the graph to one relationship predicate.'),
};

export const getGraphTool = {
  name: 'get_graph',
  description:
    'This engagement’s provenance graph — entity and fact nodes, relationship edges — optionally ' +
    'filtered by entity type or predicate. Use this to check what the graph actually knows before answering.',
  inputSchema,
  async handler(
    input: {
      entityType?: z.infer<typeof inputSchema.entityType>;
      predicate?: z.infer<typeof inputSchema.predicate>;
    },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) {
    return deps.runInContext(ctx, () =>
      deps.lineage.getGraph({ entityType: input.entityType, predicate: input.predicate }),
    );
  },
};
