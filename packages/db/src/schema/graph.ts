import { foreignKey, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ENTITY_TYPES, type ExternalRef, NODE_KINDS, PREDICATES } from '@fde/core';

import { createdAt, enumFrom, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
import { encrypted } from '../columns/encrypted.js';
import { sources } from './sources.js';
import { engagements, tenants } from './tenancy.js';

export const entityTypeEnum = enumFrom('entity_type', ENTITY_TYPES);
export const nodeKindEnum = enumFrom('graph_node_kind', NODE_KINDS);
export const predicateEnum = enumFrom('predicate', PREDICATES);

export const entities = pgTable(
  'entities',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    type: entityTypeEnum('type').notNull(),
    displayName: text('display_name').notNull(),
    /** left cleartext — needed for identity-resolution joins and dedup */
    externalRefs: jsonb('external_refs').$type<ExternalRef[]>().notNull().default([]),
    /**
     * encrypted `Record<string, unknown>` — connector metadata (titles, emails,
     * notes). NOT NULL, like the jsonb column it replaced; the repository mapper
     * encrypts `{}` when a caller has no attributes (no DB-side default possible
     * for ciphertext).
     */
    attributes: encrypted('attributes').notNull(),
    /** free-text body (notes, doc contents) — application-layer encrypted */
    body: encrypted('body'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('entities', t.tenantId),
    index('entities_engagement_type_idx').on(t.engagementId, t.type),
  ],
);

/**
 * Directed edges in the stakeholder ↔ decision ↔ work graph. Endpoints are
 * polymorphic (`entity` | `fact`), so there is no FK — referential cleanup on
 * node delete is the repository layer's responsibility.
 */
export const relationships = pgTable(
  'relationships',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    fromKind: nodeKindEnum('from_kind').notNull(),
    fromId: uuid('from_id').notNull(),
    predicate: predicateEnum('predicate').notNull(),
    toKind: nodeKindEnum('to_kind').notNull(),
    toId: uuid('to_id').notNull(),
    /** the source that attests this edge, when it came from a single artifact */
    sourceId: uuid('source_id'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('relationships', t.tenantId),
    index('relationships_from_idx').on(t.fromKind, t.fromId, t.predicate),
    index('relationships_to_idx').on(t.toKind, t.toId, t.predicate),
    uniqueIndex('relationships_edge_uq').on(t.fromKind, t.fromId, t.predicate, t.toKind, t.toId),
    // the attesting source is in the same engagement as the edge
    foreignKey({
      name: 'relationships_source_fk',
      columns: [t.engagementId, t.sourceId],
      foreignColumns: [sources.engagementId, sources.id],
    }),
  ],
);
