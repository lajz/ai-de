import { foreignKey, index, pgTable, text, uuid, vector } from 'drizzle-orm/pg-core';

import { createdAt, pk, tenantIsolation } from '../columns/_helpers.js';
import { sources } from './sources.js';
import { engagements, tenants } from './tenancy.js';

/**
 * voyage-3 / bge-large dimension. Revisit when the embedding model is chosen
 * (plan open-decision #5). Changing this needs a re-embed migration.
 */
export const EMBEDDING_DIM = 1024;

export const embeddings = pgTable(
  'embeddings',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    sourceId: uuid('source_id').notNull(),
    chunkRef: text('chunk_ref').notNull(),
    model: text('model').notNull(),
    embedding: vector('embedding', { dimensions: EMBEDDING_DIM }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('embeddings', t.tenantId),
    index('embeddings_source_idx').on(t.sourceId),
    index('embeddings_hnsw_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    // the chunked source is in the same engagement as its embedding
    foreignKey({
      name: 'embeddings_source_fk',
      columns: [t.engagementId, t.sourceId],
      foreignColumns: [sources.engagementId, sources.id],
    }).onDelete('cascade'),
  ],
);
