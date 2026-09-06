import { z } from 'zod';

export const ENTITY_TYPES = ['person', 'organization', 'work_item', 'document', 'meeting'] as const;
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = (typeof ENTITY_TYPES)[number];

/** A pointer to the same real-world entity in an origin system. */
export const externalRefSchema = z.object({
  connector: z.string().min(1),
  externalId: z.string().min(1),
  url: z.string().url().optional(),
});
export type ExternalRef = z.infer<typeof externalRefSchema>;
