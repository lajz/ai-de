import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, enumFrom, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
import { engagements, tenants } from './tenancy.js';

export const connectorSyncStatusEnum = enumFrom('connector_sync_status', [
  'idle',
  'running',
  'error',
] as const);

/**
 * One row per `(engagement, connector)` — the incremental-sync bookmark the
 * generic `ConnectorSync` Temporal workflow reads and advances.
 *
 * `cursor` is the connector's own opaque `SyncCursor` (`@fde/core`) — for
 * Granola, the `updatedAt` of the last document ingested. Deliberately NOT
 * encrypted: it is a sync position marker (a timestamp / page token), the same
 * cleartext-operational-locator rationale as `capture_sessions.meeting_url`. A
 * `Connector` MUST NOT encode a secret or artifact content in its cursor — it
 * is persisted and logged as plaintext. The artifacts the cursor points at land
 * in `sources` with `raw_body` field-encrypted as usual.
 */
export const connectorSyncState = pgTable(
  'connector_sync_state',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    /** opaque connector `SyncCursor`; null before the first successful run */
    cursor: text('cursor'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    status: connectorSyncStatusEnum('status').notNull().default('idle'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('connector_sync_state', t.tenantId),
    uniqueIndex('connector_sync_state_engagement_connector_uq').on(t.engagementId, t.connector),
  ],
);
