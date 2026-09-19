import { sql } from 'drizzle-orm';
import { boolean, pgPolicy, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { appRole, createdAt, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
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
 *
 * `externalScopeRef` binds this engagement's connection to one external
 * workspace/org/repo — a Linear organization id today, a GitHub `owner/repo`
 * later. It is what a webhook receiver (`apps/api/src/webhooks`) looks up by,
 * to turn a verified-but-tenant-blind payload into `(tenantId, engagementId)`.
 * The partial unique index is the actual security property: it is what stops a
 * second engagement (possibly a different tenant) from claiming a scope
 * another engagement already owns, which would otherwise let it silently
 * receive that engagement's webhook events (verification is against a
 * connector-wide shared secret, not a per-connection one).
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
    /** null → unclaimed; see the table doc comment above */
    externalScopeRef: text('external_scope_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('connector_config', t.tenantId),
    uniqueIndex('connector_config_engagement_connector_uq').on(t.engagementId, t.connector),
    uniqueIndex('connector_config_scope_uq')
      .on(t.connector, t.externalScopeRef)
      .where(sql`${t.externalScopeRef} is not null`),
    // Narrow, deliberate RLS carve-out: a claimed scope ref is visible to a
    // SELECT from ANY tenant context (including none at all), not just the
    // owning one. This is what lets the webhook receiver map
    // `(connector, external_scope_ref)` → `(tenant_id, engagement_id)` before it
    // has a tenant to scope a `withTenant` transaction to — see
    // `selectConnectorConfigByScopeRef`. It only widens SELECT visibility
    // (combined with `connector_config_tenant_isolation` via OR, permissive
    // policies on the same command); INSERT/UPDATE/DELETE remain governed
    // solely by the tenant-isolation policy above. The blast radius of this
    // carve-out is small: `external_scope_ref` is not a secret (an external
    // workspace/org/repo id, not a credential), and callers only ever SELECT
    // the id columns they need — `credential_ref` ciphertext is never read
    // through this path, and even if it were, it is useless without the
    // engagement DEK.
    pgPolicy('connector_config_scope_lookup', {
      as: 'permissive',
      for: 'select',
      to: appRole,
      using: sql`${t.externalScopeRef} is not null`,
    }),
  ],
);
