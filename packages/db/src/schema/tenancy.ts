import { pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { ENGAGEMENT_STATUSES, REGIONS, RETENTION_POLICIES } from '@fde/core';

import {
  createdAt,
  enumFrom,
  pk,
  selfTenantIsolation,
  tenantIsolation,
  updatedAt,
} from '../columns/_helpers.js';

export const regionEnum = enumFrom('region', REGIONS);
export const retentionPolicyEnum = enumFrom('retention_policy', RETENTION_POLICIES);
export const engagementStatusEnum = enumFrom('engagement_status', ENGAGEMENT_STATUSES);
export const userStatusEnum = enumFrom('user_status', ['active', 'disabled'] as const);

/**
 * The top-level customer account. NOT row-scoped by `tenant_id` (it *is* the
 * tenant); `selfTenantIsolation` scopes the app role to the active tenant's row
 * by primary key, and `harden-rls.sql` ENABLE/FORCEs RLS and revokes writes.
 * Tenant provisioning runs on a privileged (BYPASSRLS) connection.
 */
export const tenants = pgTable(
  'tenants',
  {
    id: pk(),
    name: text('name').notNull(),
    regionPin: regionEnum('region_pin').notNull().default('us'),
    /** KMS key ref for this tenant's CMK — root of the per-engagement DEK tree */
    cmkKeyRef: text('cmk_key_ref').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [selfTenantIsolation(t.id)],
);

export const users = pgTable(
  'users',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    email: text('email').notNull(),
    name: text('name'),
    workosUserId: text('workos_user_id'),
    status: userStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('users_tenant_email_uq').on(t.tenantId, t.email),
    tenantIsolation('users', t.tenantId),
    // FK target for identities' composite `(tenant_id, id)` reference
    unique('users_tenant_id_uq').on(t.tenantId, t.id),
  ],
);

/**
 * An FDE-org ↔ end-customer relationship: the unit of cryptographic isolation
 * (`wrappedDek`), data residency (`regionPin`), retention, and lifecycle.
 */
export const engagements = pgTable(
  'engagements',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    endCustomerName: text('end_customer_name').notNull(),
    regionPin: regionEnum('region_pin').notNull(),
    retentionPolicy: retentionPolicyEnum('retention_policy').notNull(),
    /**
     * The engagement's data-encryption key, wrapped under the tenant CMK (or the
     * BYOK key), base64. NULL once crypto-shredded — the DEK is then unrecoverable.
     */
    wrappedDek: text('wrapped_dek'),
    /** customer-managed key ARN when BYOK/CMEK is in effect — the crypto-shred handle */
    byokKeyArn: text('byok_key_arn'),
    status: engagementStatusEnum('status').notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('engagements', t.tenantId),
    uniqueIndex('engagements_tenant_customer_uq').on(t.tenantId, t.endCustomerName),
  ],
);
