import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { EVIDENCE_RELATIONS, FACT_STATUSES, FACT_TYPES } from '@fde/core';

import { createdAt, enumFrom, pk, tenantIsolation } from '../columns/_helpers.js';
import { encrypted } from '../columns/encrypted.js';
import { sources } from './sources.js';
import { engagements, tenants } from './tenancy.js';

export const factTypeEnum = enumFrom('fact_type', FACT_TYPES);
export const factStatusEnum = enumFrom('fact_status', FACT_STATUSES);
export const evidenceRelationEnum = enumFrom('evidence_relation', EVIDENCE_RELATIONS);

export const extractionRuns = pgTable(
  'extraction_runs',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    promptVersion: text('prompt_version').notNull(),
    inputSourceIds: jsonb('input_source_ids').$type<string[]>().notNull(),
    costUsd: doublePrecision('cost_usd'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('extraction_runs', t.tenantId),
    unique('extraction_runs_engagement_id_uq').on(t.engagementId, t.id),
  ],
);

export const facts = pgTable(
  'facts',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    type: factTypeEnum('type').notNull(),
    /** short, non-encrypted label — list views + lexical search */
    summary: text('summary').notNull(),
    /** full detail — application-layer encrypted */
    body: encrypted('body'),
    status: factStatusEnum('status').notNull().default('open'),
    confidence: doublePrecision('confidence'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }),
    extractionRunId: uuid('extraction_run_id'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('facts', t.tenantId),
    index('facts_engagement_type_idx').on(t.engagementId, t.type),
    // FK target for evidence's composite `(engagement_id, id)` reference
    unique('facts_engagement_id_uq').on(t.engagementId, t.id),
    // an extraction run referenced by a fact is in the same engagement
    foreignKey({
      name: 'facts_extraction_run_fk',
      columns: [t.engagementId, t.extractionRunId],
      foreignColumns: [extractionRuns.engagementId, extractionRuns.id],
    }),
  ],
);

export const evidence = pgTable(
  'evidence',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    // denormalized from `factId` so CryptoShred can enumerate every encrypted row
    // for an engagement without a join. The composite FKs below pin fact_id /
    // source_id / extraction_run_id to this same engagement, so the
    // denormalization can never drift.
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    factId: uuid('fact_id').notNull(),
    sourceId: uuid('source_id').notNull(),
    /** verbatim supporting quote — application-layer encrypted */
    quote: encrypted('quote'),
    charStart: integer('char_start'),
    charEnd: integer('char_end'),
    relation: evidenceRelationEnum('relation').notNull().default('supports'),
    extractionRunId: uuid('extraction_run_id'),
    createdAt: createdAt(),
  },
  (t) => [
    tenantIsolation('evidence', t.tenantId),
    index('evidence_fact_idx').on(t.factId),
    index('evidence_source_idx').on(t.sourceId),
    // mirrors `charSpanSchema` in @fde/core: a `[start, end)` half-open span
    check(
      'evidence_char_span_ck',
      sql`${t.charStart} is null or ${t.charEnd} is null or (${t.charStart} >= 0 and ${t.charEnd} > ${t.charStart})`,
    ),
    foreignKey({
      name: 'evidence_fact_fk',
      columns: [t.engagementId, t.factId],
      foreignColumns: [facts.engagementId, facts.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'evidence_source_fk',
      columns: [t.engagementId, t.sourceId],
      foreignColumns: [sources.engagementId, sources.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'evidence_extraction_run_fk',
      columns: [t.engagementId, t.extractionRunId],
      foreignColumns: [extractionRuns.engagementId, extractionRuns.id],
    }),
  ],
);
