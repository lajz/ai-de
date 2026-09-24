import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { Ciphertext, EngagementId, TenantId } from '@fde/core';

import type { Database, DbTransaction } from './client.js';
import { withTenant } from './rls.js';
import {
  aclSnapshots,
  connectorConfig,
  entities,
  evidence,
  facts,
  sources,
} from './schema/index.js';
import { CRYPTO_COLUMNS } from './schema/tables.js';

const DEFAULT_BATCH_SIZE = 500;

/**
 * A zero-length ciphertext — used to blank a `NOT NULL` 🔒 column (`entities.attributes`,
 * `acl_snapshots.principalRules`) that can't take SQL `NULL`. This is storage
 * hygiene, not the security boundary: the column is already permanently
 * unreadable the instant the engagement DEK is destroyed (`shredEngagement`),
 * regardless of whether this purge ever runs.
 */
const EMPTY_CIPHERTEXT = new Uint8Array(0) as Ciphertext;

export interface PurgeEngagementCiphertextResult {
  totalRowsPurged: number;
  perTable: Record<string, number>;
}

export interface PurgeEngagementCiphertextOptions {
  /** rows updated per statement, per table (default 500) — keeps one purge from holding a large lock/transaction */
  batchSize?: number;
  /** called after each committed batch — the caller's hook for a Temporal activity heartbeat */
  onBatch?: (progress: { table: string; purgedInBatch: number; totalPurged: number }) => void;
}

interface EngagementRef {
  tenantId: TenantId;
  engagementId: EngagementId;
}

interface TablePurger {
  /** must match a key of `CRYPTO_COLUMNS` — checked below so a new 🔒 column can't silently go unpurged */
  name: string;
  purgeBatch: (tx: DbTransaction, ref: EngagementRef, limit: number) => Promise<number>;
}

/**
 * `CRYPTO_COLUMNS`-registered tables that carry an `engagement_id` column —
 * every one of these needs its ciphertext purged when an engagement is
 * crypto-shredded. `identities` is deliberately absent: it is tenant-scoped
 * (per-user connector credentials), not engagement-scoped, and a shredded
 * engagement's users may still have identities used elsewhere in the tenant.
 *
 * Each purger selects a batch of ids that still carry ciphertext (`length(col)
 * > 0` — true for real ciphertext, false/unknown once purged), then updates
 * just that batch. Every batch runs in its own `withTenant` transaction (see
 * `purgeEngagementCiphertext`), so a large purge never holds one lock/tx open
 * across the whole engagement, and a retried activity naturally skips
 * already-purged rows instead of re-selecting them.
 */
const TABLE_PURGERS: TablePurger[] = [
  {
    name: 'facts',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: facts.id })
        .from(facts)
        .where(
          and(
            eq(facts.tenantId, ref.tenantId),
            eq(facts.engagementId, ref.engagementId),
            sql`length(${facts.body}) > 0`,
          ),
        )
        .orderBy(asc(facts.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(facts)
        .set({ body: null })
        .where(
          and(
            eq(facts.tenantId, ref.tenantId),
            eq(facts.engagementId, ref.engagementId),
            inArray(facts.id, ids),
          ),
        );
      return ids.length;
    },
  },
  {
    name: 'evidence',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.tenantId, ref.tenantId),
            eq(evidence.engagementId, ref.engagementId),
            sql`length(${evidence.quote}) > 0`,
          ),
        )
        .orderBy(asc(evidence.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(evidence)
        .set({ quote: null })
        .where(
          and(
            eq(evidence.tenantId, ref.tenantId),
            eq(evidence.engagementId, ref.engagementId),
            inArray(evidence.id, ids),
          ),
        );
      return ids.length;
    },
  },
  {
    name: 'sources',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: sources.id })
        .from(sources)
        .where(
          and(
            eq(sources.tenantId, ref.tenantId),
            eq(sources.engagementId, ref.engagementId),
            sql`length(${sources.rawBody}) > 0`,
          ),
        )
        .orderBy(asc(sources.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(sources)
        .set({ rawBody: null })
        .where(
          and(
            eq(sources.tenantId, ref.tenantId),
            eq(sources.engagementId, ref.engagementId),
            inArray(sources.id, ids),
          ),
        );
      return ids.length;
    },
  },
  {
    // `principalRules` is NOT NULL — blanked to an empty ciphertext, not SQL NULL.
    name: 'acl_snapshots',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: aclSnapshots.id })
        .from(aclSnapshots)
        .where(
          and(
            eq(aclSnapshots.tenantId, ref.tenantId),
            eq(aclSnapshots.engagementId, ref.engagementId),
            sql`length(${aclSnapshots.principalRules}) > 0`,
          ),
        )
        .orderBy(asc(aclSnapshots.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(aclSnapshots)
        .set({ principalRules: EMPTY_CIPHERTEXT })
        .where(
          and(
            eq(aclSnapshots.tenantId, ref.tenantId),
            eq(aclSnapshots.engagementId, ref.engagementId),
            inArray(aclSnapshots.id, ids),
          ),
        );
      return ids.length;
    },
  },
  {
    // `attributes` is NOT NULL (→ empty ciphertext); `body` is nullable (→ NULL).
    name: 'entities',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: entities.id })
        .from(entities)
        .where(
          and(
            eq(entities.tenantId, ref.tenantId),
            eq(entities.engagementId, ref.engagementId),
            sql`(length(${entities.attributes}) > 0 or length(${entities.body}) > 0)`,
          ),
        )
        .orderBy(asc(entities.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(entities)
        .set({ attributes: EMPTY_CIPHERTEXT, body: null })
        .where(
          and(
            eq(entities.tenantId, ref.tenantId),
            eq(entities.engagementId, ref.engagementId),
            inArray(entities.id, ids),
          ),
        );
      return ids.length;
    },
  },
  {
    name: 'connector_config',
    purgeBatch: async (tx, ref, limit) => {
      const rows = await tx
        .select({ id: connectorConfig.id })
        .from(connectorConfig)
        .where(
          and(
            eq(connectorConfig.tenantId, ref.tenantId),
            eq(connectorConfig.engagementId, ref.engagementId),
            sql`length(${connectorConfig.credentialRef}) > 0`,
          ),
        )
        .orderBy(asc(connectorConfig.id))
        .limit(limit);
      if (rows.length === 0) return 0;
      const ids = rows.map((r) => r.id);
      await tx
        .update(connectorConfig)
        .set({ credentialRef: null })
        .where(
          and(
            eq(connectorConfig.tenantId, ref.tenantId),
            eq(connectorConfig.engagementId, ref.engagementId),
            inArray(connectorConfig.id, ids),
          ),
        );
      return ids.length;
    },
  },
];

// Drift guard: every CRYPTO_COLUMNS table with an engagement_id column (i.e.
// every one except `identities`, asserted by name) must have a purger above.
// Throws at import time — a new 🔒 table registered in `schema/tables.ts`
// without a matching entry here fails loudly instead of silently going
// unpurged.
{
  const registered = Object.keys(CRYPTO_COLUMNS)
    .filter((k) => k !== 'identities')
    .sort();
  const purged = TABLE_PURGERS.map((p) => p.name).sort();
  if (registered.join(',') !== purged.join(',')) {
    throw new Error(
      `crypto-shred-purge: CRYPTO_COLUMNS registers [${registered.join(', ')}] but TABLE_PURGERS covers [${purged.join(', ')}] — update crypto-shred-purge.ts`,
    );
  }
}

/**
 * Purges (nulls, or blanks to an empty ciphertext where `NOT NULL`) every
 * `CRYPTO_COLUMNS`-registered, engagement-scoped 🔒 column for one engagement.
 * Storage hygiene, not the security boundary — the columns are already
 * permanently undecryptable once `shredEngagement` has dropped the DEK, so
 * this may safely run well after the shred, retry on failure, and take a
 * while on a large engagement.
 *
 * Each table is purged batch-by-batch, each batch its own `withTenant`
 * transaction (so no single transaction holds locks across the whole
 * engagement), continuing until a batch comes back empty. Idempotent by
 * construction: a batch only ever selects rows that still carry ciphertext, so
 * a retried call (or a second run against an already-purged engagement) does
 * no work.
 */
export async function purgeEngagementCiphertext(
  db: Database,
  ref: EngagementRef,
  opts: PurgeEngagementCiphertextOptions = {},
): Promise<PurgeEngagementCiphertextResult> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const perTable: Record<string, number> = {};
  let totalRowsPurged = 0;

  for (const purger of TABLE_PURGERS) {
    let purgedForTable = 0;
    for (;;) {
      const purgedInBatch = await withTenant(db, ref.tenantId, (tx) =>
        purger.purgeBatch(tx, ref, batchSize),
      );
      if (purgedInBatch === 0) break;
      purgedForTable += purgedInBatch;
      totalRowsPurged += purgedInBatch;
      opts.onBatch?.({ table: purger.name, purgedInBatch, totalPurged: totalRowsPurged });
      if (purgedInBatch < batchSize) break;
    }
    perTable[purger.name] = purgedForTable;
  }

  return { totalRowsPurged, perTable };
}
