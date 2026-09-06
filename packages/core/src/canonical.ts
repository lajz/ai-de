import { z } from 'zod';

import { entityTypeSchema, externalRefSchema } from './entities.js';
import { predicateSchema } from './relationships.js';

/** A canonical graph node produced by `Connector.normalize`. Still untrusted. */
export const canonicalEntitySchema = z.object({
  kind: z.literal('entity'),
  type: entityTypeSchema,
  displayName: z.string().min(1),
  externalRefs: z.array(externalRefSchema).min(1),
  attributes: z.record(z.unknown()).default({}),
  /** free-text body (meeting notes, doc contents) — encrypted at rest */
  body: z.string().optional(),
});
export type CanonicalEntity = z.infer<typeof canonicalEntitySchema>;

/** A canonical graph edge produced by `Connector.normalize`. */
export const canonicalRelationshipSchema = z.object({
  kind: z.literal('relationship'),
  from: externalRefSchema,
  predicate: predicateSchema,
  to: externalRefSchema,
});
export type CanonicalRelationship = z.infer<typeof canonicalRelationshipSchema>;

export const canonicalRecordSchema = z.discriminatedUnion('kind', [
  canonicalEntitySchema,
  canonicalRelationshipSchema,
]);
export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;
