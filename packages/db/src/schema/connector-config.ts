import { boolean, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
import { encrypted } from '../columns/encrypted.js';
import { engagements, retentionPolicyEnum, tenants } from './tenancy.js';

/**
 * Per-`(engagement, connector)` admin configuration — the row the `/admin`
 * connector-config API upserts and every connector-driven Temporal workflow
 * reads before it starts. Distinct from `connector_sync_state`: this is the
 * *desired* state (is the connector on, what retention override, which
 * credential), that one is the *observed* sync bookmark.
 *
 * `credentialRef` is the Nango-ready seam. Today it is an encrypted secret — a
 * Granola `grn_` bearer token or a Recall key — decrypted with the engagement
 * DEK only inside the sync activity. At M3 it becomes the Nango connection id
 * (still encrypted, same column, same codec); nothing else about this table
 * changes. Never returned by the API — the read endpoints expose only
 * `hasCredential: boolean`.
 */
export const connectorConfig = pgTable(
  'connector_config',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    connector: text('connector').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** null → inherit the engagement's `retention_policy` (via `effectiveRetention`) */
    retentionOverride: retentionPolicyEnum('retention_override'),
    /** encrypted bearer token / Recall key today; the Nango connection id at M3 */
    credentialRef: encrypted('credential_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('connector_config', t.tenantId),
    uniqueIndex('connector_config_engagement_connector_uq').on(t.engagementId, t.connector),
  ],
);
