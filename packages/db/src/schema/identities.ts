import { foreignKey, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { createdAt, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
import { encrypted } from '../columns/encrypted.js';
import { tenants, users } from './tenancy.js';

/** A user's linked external account for a connector (per-user OAuth / MCP). */
export const identities = pgTable(
  'identities',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    userId: uuid('user_id').notNull(),
    connector: text('connector').notNull(),
    externalAccountId: text('external_account_id').notNull(),
    scopes: jsonb('scopes').$type<string[]>().notNull().default([]),
    /** encrypted ref to the vaulted connector credential (e.g. a Nango connection id) */
    connectionSecretRef: encrypted('connection_secret_ref'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('identities', t.tenantId),
    uniqueIndex('identities_user_connector_uq').on(t.userId, t.connector, t.externalAccountId),
    // a credential belongs to a user in the same tenant
    foreignKey({
      name: 'identities_user_fk',
      columns: [t.tenantId, t.userId],
      foreignColumns: [users.tenantId, users.id],
    }).onDelete('cascade'),
  ],
);
