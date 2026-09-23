import { z } from 'zod';

import type { McpToolDeps } from '../deps.js';
import type { ToolCallContext } from '../context.js';

const inputSchema = {
  entityId: z.string().min(1).describe('The entity id to trace derivation for.'),
};

export const getEntityProvenanceTool = {
  name: 'get_entity_provenance',
  description:
    'Derivation detail for one entity: its type/name, every relationship edge touching it (joined to ' +
    'the source it was derived from), and the fact-kind counterparts among those edges.',
  inputSchema,
  async handler(
    input: { entityId: z.infer<typeof inputSchema.entityId> },
    ctx: ToolCallContext,
    deps: McpToolDeps,
  ) {
    return deps.runInContext(ctx, () => deps.lineage.getEntityProvenance(input.entityId));
  },
};
