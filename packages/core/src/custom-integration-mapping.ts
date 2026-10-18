import { z } from 'zod';

import { entityTypeSchema } from './entities.js';
import { sourceKindSchema } from './provenance.js';
import { predicateSchema } from './relationships.js';

const SEGMENT = String.raw`[A-Za-z_$][A-Za-z0-9_$-]*(?:\[\d+\])*`;
const DOT_PATH_RE = new RegExp(`^${SEGMENT}(?:\\.${SEGMENT})*$`);

/**
 * A deliberately tiny path language over a JSON payload: dot-separated
 * identifier segments, each with optional `[n]` array-index accessors
 * (`a.b[0].c`). No wildcards, filters, or expressions — customers describe
 * where a value lives, never how to compute one.
 */
export const dotPathSchema = z.string().max(256).regex(DOT_PATH_RE, 'invalid path (use a.b[0].c)');
export type DotPath = z.infer<typeof dotPathSchema>;

const mappingKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/, 'key must be an identifier');

/** One graph entity derived from the pushed payload. */
export const customEntityMappingSchema = z.object({
  /** local handle relationships refer to; unique within the mapping */
  key: mappingKeySchema,
  type: entityTypeSchema,
  externalIdPath: dotPathSchema,
  displayNamePath: dotPathSchema,
  bodyPath: dotPathSchema.optional(),
  /** attribute name → path in the payload */
  attributes: z.record(z.string().min(1).max(64), dotPathSchema).default({}),
});
export type CustomEntityMapping = z.infer<typeof customEntityMappingSchema>;

export const customRelationshipMappingSchema = z.object({
  from: mappingKeySchema,
  predicate: predicateSchema,
  to: mappingKeySchema,
});
export type CustomRelationshipMapping = z.infer<typeof customRelationshipMappingSchema>;

/** Describes the push event itself (the `sources` dedupe key), not the entities. */
export const customArtifactMappingSchema = z.object({
  externalIdPath: dotPathSchema,
  kind: sourceKindSchema,
  occurredAtPath: dotPathSchema,
  urlPermalinkPath: dotPathSchema.optional(),
});
export type CustomArtifactMapping = z.infer<typeof customArtifactMappingSchema>;

export const customIntegrationMappingSchema = z
  .object({
    artifact: customArtifactMappingSchema,
    entities: z.array(customEntityMappingSchema).min(1).max(50),
    relationships: z.array(customRelationshipMappingSchema).max(100).default([]),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    m.entities.forEach((e, i) => {
      if (keys.has(e.key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entities', i, 'key'],
          message: `duplicate entity key "${e.key}"`,
        });
      }
      keys.add(e.key);
    });
    m.relationships.forEach((r, i) => {
      for (const side of ['from', 'to'] as const) {
        if (!keys.has(r[side])) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['relationships', i, side],
            message: `unknown entity key "${r[side]}"`,
          });
        }
      }
    });
  });
export type CustomIntegrationMapping = z.infer<typeof customIntegrationMappingSchema>;
