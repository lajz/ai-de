import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';

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
