import { z } from 'zod';

import { aclSnapshotSchema, sourceKindSchema } from './provenance.js';

/**
 * The unit a Connector emits. This is an untrusted boundary — especially for
 * custom customer connectors — so callers MUST parse with `rawArtifactSchema`
 * before the artifact enters the pipeline.
 */
export const rawArtifactSchema = z.object({
  connector: z.string().min(1),
  externalId: z.string().min(1),
  kind: sourceKindSchema,
  /** deep link back to the artifact in its origin system */
  urlPermalink: z.string().url().optional(),
  /** origin workspace / org id */
  workspaceRef: z.string().optional(),
  /** origin container id — channel, project, folder */
  containerRef: z.string().optional(),
  /** origin author id */
  authorRef: z.string().optional(),
  occurredAt: z.string().datetime(),
  /** the artifact body; omitted under `reference-only` retention */
  body: z.string().optional(),
  /** structured payload preserved for re-normalization */
  raw: z.record(z.unknown()).optional(),
  acl: aclSnapshotSchema,
});
export type RawArtifact = z.infer<typeof rawArtifactSchema>;
