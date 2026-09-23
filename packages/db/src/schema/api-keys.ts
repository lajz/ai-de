import { index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { createdAt, pk } from '../columns/_helpers.js';
import { tenants, users } from './tenancy.js';

/**
 * External MCP-caller credentials (v1: internal issuance only — see the
 * agentic Q&A design). A key resolves to a service-account `users` row
 * exactly the way a session resolves to a human one; from there every
 * downstream check (`canViewEngagement`, RLS, `filterCandidatesByAcl`) is
 * unchanged — this table is the ONLY new piece.
 *
 * Deliberately carries **no** `tenantIsolation` RLS policy and is
 * deliberately absent from `TENANT_SCOPED_TABLES`/`sql/harden-rls.sql`'s
 * `tenant_tables` array: resolving a bare key to a tenant has to run
 * *before* `app.tenant_id` can be set (`withTenant` needs the tenant id this
 * lookup produces), so a policy keyed on `app.tenant_id` would make every
 * lookup resolve to no rows — the same chicken-and-egg problem
 * `tenants_self_isolation` exists to document, not solve, for that table.
 * The lookup is a bare `SELECT ... WHERE key_prefix = $1`, safe without RLS
 * because nothing about it depends on which tenant is asking.
 */
export const apiKeys = pgTable(
  'api_keys',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    /** the service-account `users` row this key authenticates as */
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** sha256(raw key), hex — never the raw key itself */
    keyHash: text('key_hash').notNull(),
    /** short, indexed, non-secret prefix of the raw key — narrows the lookup before the hash compare */
    keyPrefix: text('key_prefix').notNull(),
    label: text('label').notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => [
    unique('api_keys_key_hash_uq').on(t.keyHash),
    index('api_keys_key_prefix_idx').on(t.keyPrefix),
  ],
);
