import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAt, enumFrom, pk, tenantIsolation } from '../columns/_helpers.js';
import { entities } from './graph.js';
import { tenants } from './tenancy.js';

export const IDENTITY_REVIEW_STATUSES = ['pending', 'merged', 'rejected'] as const;
export type IdentityReviewStatus = (typeof IDENTITY_REVIEW_STATUSES)[number];
export const identityReviewStatusEnum = enumFrom(
  'identity_review_status',
  IDENTITY_REVIEW_STATUSES,
);

/** The scored signals behind a queued fuzzy match — kept for the human reviewer. */
export interface MatchSignals {
  /** normalized-name similarity, 0–1 (Jaro-Winkler) */
  nameSimilarity?: number;
  /** the two entities share a normalized email domain */
  sharedDomain?: boolean;
  /** the two entities are `member_of` the same organization entity */
  sharedOrg?: boolean;
}

/**
 * Fuzzy entity-match candidates awaiting a human decision (`@fde/identity`).
 * Deterministic matches never land here — they merge in `resolveEntity`. A row
 * is one unordered `{entityA, entityB}` pair (the check constraint pins
 * `entity_a_id < entity_b_id` so the unique index dedupes regardless of the
 * order the pair was discovered in). `rejected` rows are kept so the pair is not
 * re-queued. Tenant-scoped only — the pair may span engagements within a tenant.
 */
export const identityReviewQueue = pgTable(
  'identity_review_queue',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    entityAId: uuid('entity_a_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    entityBId: uuid('entity_b_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    score: doublePrecision('score').notNull(),
    signals: jsonb('signals').$type<MatchSignals>().notNull().default({}),
    status: identityReviewStatusEnum('status').notNull().default('pending'),
    /** actor id that merged / rejected — null while pending */
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('identity_review_queue', t.tenantId),
    uniqueIndex('identity_review_queue_pair_uq').on(t.entityAId, t.entityBId),
    check('identity_review_queue_pair_order_ck', sql`${t.entityAId} < ${t.entityBId}`),
  ],
);
