import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { withEngagement } from './engagement.js';
import { selectEngagementFacts } from './retrieval.js';
import { engagements, facts, tenants } from './schema/index.js';

// Integration test — needs a migrated + hardened database, same convention as
// `lineage.integration.test.ts`:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/db test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('selectEngagementFacts pagination (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  async function seedEngagement(): Promise<EngagementId> {
    const engagementId = randomUUID() as EngagementId;
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: `Acme ${engagementId.slice(0, 8)}`,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  /** Seeds `count` facts with distinct, ascending `createdAt` timestamps (oldest first). */
  async function seedFacts(engagementId: EngagementId, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    await handle.db.insert(facts).values(
      ids.map((id, i) => ({
        id,
        tenantId,
        engagementId,
        type: 'decision' as const,
        summary: `fact ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
      })),
    );
    return ids;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'A', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('pages newest-first with no overlap or gaps across the boundary', async () => {
    const engagementId = await seedEngagement();
    const ids = await seedFacts(engagementId, 5);
    const newestFirst = [...ids].reverse();

    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const page1 = await selectEngagementFacts(tx, tenantId, engagementId, { limit: 2 });
      expect(page1.rows.map((r) => r.id)).toEqual(newestFirst.slice(0, 2));
      expect(page1.nextCursor).toBeDefined();

      const page2 = await selectEngagementFacts(tx, tenantId, engagementId, {
        limit: 2,
        cursor: page1.nextCursor,
      });
      expect(page2.rows.map((r) => r.id)).toEqual(newestFirst.slice(2, 4));
      expect(page2.nextCursor).toBeDefined();

      const page3 = await selectEngagementFacts(tx, tenantId, engagementId, {
        limit: 2,
        cursor: page2.nextCursor,
      });
      expect(page3.rows.map((r) => r.id)).toEqual(newestFirst.slice(4, 5));
      // last page — no more rows past it
      expect(page3.nextCursor).toBeUndefined();

      const all = [...page1.rows, ...page2.rows, ...page3.rows].map((r) => r.id);
      expect(all).toEqual(newestFirst);
      expect(new Set(all).size).toBe(ids.length);
    });
  });

  it('returns everything in one page with no cursor when under the limit', async () => {
    const engagementId = await seedEngagement();
    const ids = await seedFacts(engagementId, 3);

    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const page = await selectEngagementFacts(tx, tenantId, engagementId, { limit: 10 });
      expect(page.rows).toHaveLength(ids.length);
      expect(page.nextCursor).toBeUndefined();
    });
  });

  it('rejects a malformed cursor', async () => {
    const engagementId = await seedEngagement();
    await seedFacts(engagementId, 1);

    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      await expect(
        selectEngagementFacts(tx, tenantId, engagementId, { cursor: 'not-a-cursor' }),
      ).rejects.toThrow(/malformed/);
    });
  });
});
