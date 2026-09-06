import { index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { createdAt, enumFrom, pk, tenantIsolation } from '../columns/_helpers.js';
import { engagements, tenants } from './tenancy.js';

export const actorTypeEnum = enumFrom('actor_type', ['user', 'system', 'break_glass'] as const);

/**
 * Append-only. Every read of tenant content, every retrieval, and every
 * break-glass action lands here. `sql/harden-rls.sql` revokes UPDATE/DELETE for
 * the app role. Surfaced to tenants via `@fde/audit` (build: M1).
 */
export const accessLog = pgTable(
  'access_log',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id').references(() => engagements.id, { onDelete: 'set null' }),
    actorType: actorTypeEnum('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type'),
    resourceId: text('resource_id'),
    authzDecision: jsonb('authz_decision').$type<Record<string, unknown>>(),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('access_log', t.tenantId),
    index('access_log_engagement_idx').on(t.engagementId, t.createdAt),
  ],
);

/**
 * A time-boxed, second-person-approved grant of standing-access-free content
 * access for one engagement. `@fde/audit` is the only writer; every state
 * change (request/approve/revoke) also lands an `access_log` row in the same
 * transaction. `ttlMinutes` is captured at request time and applied to compute
 * `expires_at` at approval, since the requester and approver are separate calls.
 */
export const breakGlassGrants = pgTable(
  'break_glass_grants',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    requestedBy: text('requested_by').notNull(),
    approvedBy: text('approved_by'),
    reason: text('reason').notNull(),
    ttlMinutes: integer('ttl_minutes').notNull().default(60),
    requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    tenantIsolation('break_glass_grants', t.tenantId),
    index('break_glass_grants_engagement_idx').on(t.engagementId),
  ],
);
