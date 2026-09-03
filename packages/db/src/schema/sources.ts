import {
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { SOURCE_KINDS } from '@fde/core';

import { createdAt, enumFrom, pk, tenantIsolation } from '../columns/_helpers.js';
import { encrypted } from '../columns/encrypted.js';
import { engagements, retentionPolicyEnum, tenants } from './tenancy.js';

export const sourceKindEnum = enumFrom('source_kind', SOURCE_KINDS);
export const aclRefreshStateEnum = enumFrom('acl_refresh_state', [
  'fresh',
  'stale',
  'refreshing',
  'error',
] as const);

export const aclSnapshots = pgTable(
  'acl_snapshots',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    /** connector + external id of the resource this ACL governs */
    sourceRef: text('source_ref').notNull(),
    /** encrypted `AclPrincipalRule[]` — external user/group identifiers. NOT
     * NULL, like the jsonb column it replaced; an empty ACL is an encrypted `[]`. */
    principalRules: encrypted('principal_rules').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    ttlSeconds: integer('ttl_seconds').notNull(),
    refreshState: aclRefreshStateEnum('refresh_state').notNull().default('fresh'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('acl_snapshots', t.tenantId),
    // FK target for the composite `(engagement_id, id)` references below.
    unique('acl_snapshots_engagement_id_uq').on(t.engagementId, t.id),
  ],
);

export const sources = pgTable(
  'sources',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    externalId: text('external_id').notNull(),
    kind: sourceKindEnum('kind').notNull(),
    urlPermalink: text('url_permalink'),
    workspaceRef: text('workspace_ref'),
    containerRef: text('container_ref'),
    authorRef: text('author_ref'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
    /** sha256 of the canonical artifact payload — dedupe key alongside external_id */
    contentHash: text('content_hash').notNull(),
    /** S3 key when the encrypted raw blob is retained; null under reference-only */
    rawObjectKey: text('raw_object_key'),
    /** small encrypted bodies stored inline; null under reference-only */
    rawBody: encrypted('raw_body'),
    retentionPolicy: retentionPolicyEnum('retention_policy').notNull(),
    /** composite FK below keeps this in the same engagement as the source */
    aclSnapshotId: uuid('acl_snapshot_id'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('sources', t.tenantId),
    uniqueIndex('sources_dedupe_uq').on(t.engagementId, t.connector, t.externalId, t.contentHash),
    index('sources_engagement_occurred_idx').on(t.engagementId, t.occurredAt),
    // FK target for evidence/embeddings composite `(engagement_id, id)` refs.
    unique('sources_engagement_id_uq').on(t.engagementId, t.id),
    // an ACL snapshot must belong to the same engagement as the source it
    // governs. NO ACTION (not SET NULL — engagement_id is part of the key and is
    // NOT NULL); an acl_snapshot only dies with its engagement, which deletes
    // the source too.
    foreignKey({
      name: 'sources_acl_snapshot_fk',
      columns: [t.engagementId, t.aclSnapshotId],
      foreignColumns: [aclSnapshots.engagementId, aclSnapshots.id],
    }),
  ],
);
