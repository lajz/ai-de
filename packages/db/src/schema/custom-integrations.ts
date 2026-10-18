import type { CustomIntegrationMapping } from '@fde/core';
import { boolean, index, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, pk, updatedAt } from '../columns/_helpers.js';
import { engagements, tenants, users } from './tenancy.js';

/**
 * Self-serve inbound-push integrations: a tenant admin declares a field
 * `mapping` over an arbitrary JSON payload, then pushes data to a
 * platform-generated URL authenticated by a per-integration bearer secret.
 *
 * **Deliberately NO row-level security — read this before touching a query.**
 * Same chicken-and-egg as `api_keys` (`schema/api-keys.ts`): the public ingest
 * endpoint must resolve this exact row by primary key *before* any tenant is
 * known (no session, no api_key — the row's secret IS the credential), and
 * `withTenant` needs the tenant id that lookup produces. So the table is absent
 * from `TENANT_SCOPED_TABLES` / `sql/harden-rls.sql`'s `tenant_tables`.
 *
 * Unlike `api_keys`, this table also has a normal authenticated CRUD consumer
 * (the admin service). Since nothing in the database protects it, EVERY query
 * helper in `custom-integrations.ts` filters `tenant_id` + `engagement_id`
 * explicitly in its WHERE clause — never trust a bare `id`. Only the two
 * helpers named `...Bare` skip that, and only the ingest controller uses them.
 *
 * Grants include DELETE (unlike `api_keys`): there is no audit requirement to
 * retain a deleted integration, so the admin API hard-deletes.
 */
export const customIntegrations = pgTable(
  'custom_integrations',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** config, not a secret — stored as plain jsonb */
    mapping: jsonb('mapping').$type<CustomIntegrationMapping>().notNull(),
    /** sha256(raw secret), hex — never the raw secret itself */
    secretHash: text('secret_hash').notNull(),
    /** display-only fingerprint for the admin UI; never used for lookup */
    secretPrefix: text('secret_prefix').notNull(),
    secretSetAt: timestamp('secret_set_at', { withTimezone: true }).notNull().defaultNow(),
    lastIngestedAt: timestamp('last_ingested_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('custom_integrations_secret_hash_uq').on(t.secretHash),
    index('custom_integrations_secret_prefix_idx').on(t.secretPrefix),
    index('custom_integrations_engagement_idx').on(t.tenantId, t.engagementId),
  ],
);
