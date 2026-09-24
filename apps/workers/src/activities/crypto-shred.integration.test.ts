import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { EngagementShreddedError, FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  engagements,
  facts,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { MockActivityEnvironment } from '@temporalio/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createCryptoShredActivities,
  type PurgeShreddedCiphertextInput,
  type PurgeShreddedCiphertextResult,
  type ShredEngagementDekInput,
  type ShredEngagementDekResult,
} from './crypto-shred.js';

// Integration test — needs a migrated + hardened database, same convention as
// packages/db/src/engagement.test.ts:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/workers test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('crypto-shred activities (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  const acts = () => createCryptoShredActivities({ db: handle.db, keyProvider: provider });
  const shred = (input: ShredEngagementDekInput): Promise<ShredEngagementDekResult> =>
    new MockActivityEnvironment().run(
      acts().shredEngagementDekActivity as never,
      input as never,
    ) as Promise<ShredEngagementDekResult>;
  const purge = (input: PurgeShreddedCiphertextInput): Promise<PurgeShreddedCiphertextResult> =>
    new MockActivityEnvironment().run(
      acts().purgeShreddedCiphertextActivity as never,
      input as never,
    ) as Promise<PurgeShreddedCiphertextResult>;

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

  async function seedFact(engagementId: EngagementId): Promise<string> {
    const factId = randomUUID();
    await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx.insert(facts).values({
        id: factId,
        tenantId,
        engagementId,
        type: 'decision',
        summary: 'chose postgres',
        body: undefined,
      }),
    );
    return factId;
  }

  async function encryptFactBody(engagementId: EngagementId, factId: string, plaintext: string) {
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const body = await getCipher().encryptString('facts.body', plaintext);
      await tx.update(facts).set({ body }).where(eq(facts.id, factId));
    });
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });

  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('shredEngagementDekActivity destroys the DEK (idempotent) and purgeShreddedCiphertextActivity then nulls ciphertext + logs a distinct audit row', async () => {
    const engagementId = await seedEngagement();
    const factId = await seedFact(engagementId);
    await encryptFactBody(engagementId, factId, 'the full decision detail');

    const first = await shred({ tenantId, engagementId, actorId: 'admin-1', reason: 'offboard' });
    expect(first).toEqual({ didShred: true });

    // the DEK really is gone — even this activity's own withEngagement path now 410s
    await expect(
      withEngagement(handle.db, provider, { tenantId, engagementId }, async () => undefined),
    ).rejects.toBeInstanceOf(EngagementShreddedError);

    // re-running the shred activity (the workflow's own first step, whether or
    // not the API already called shredEngagement synchronously) is a no-op
    const second = await shred({ tenantId, engagementId, actorId: 'admin-1', reason: 'offboard' });
    expect(second).toEqual({ didShred: false });

    const [beforePurge] = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ n: sql<number>`length(${facts.body})` })
        .from(facts)
        .where(eq(facts.id, factId)),
    );
    expect(beforePurge?.n).toBeGreaterThan(0);

    const purgeResult = await purge({ tenantId, engagementId });
    expect(purgeResult.perTable.facts).toBe(1);

    const [afterPurge] = await withTenant(handle.db, tenantId, (tx) =>
      tx.select({ body: facts.body }).from(facts).where(eq(facts.id, factId)),
    );
    expect(afterPurge?.body).toBeNull();

    const auditActions = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ action: sql<string>`action` })
        .from(sql`access_log`)
        .where(sql`engagement_id = ${engagementId} order by created_at asc`),
    );
    expect(auditActions.map((r) => r.action)).toEqual([
      'crypto_shred',
      'crypto_shred_purge_completed',
    ]);
  });

  it('purgeShreddedCiphertextActivity refuses to run against an engagement that was never shredded, non-retryably, and touches nothing', async () => {
    const engagementId = await seedEngagement();
    const factId = await seedFact(engagementId);
    await encryptFactBody(engagementId, factId, 'still readable');

    await expect(purge({ tenantId, engagementId })).rejects.toThrow(/not.*shredded|shredded.*not/i);

    // untouched — still live, still decryptable
    const plaintext = await withEngagement(
      handle.db,
      provider,
      { tenantId, engagementId },
      async (tx) => {
        const [row] = await tx.select({ body: facts.body }).from(facts).where(eq(facts.id, factId));
        return getCipher().decryptString('facts.body', row!.body!);
      },
    );
    expect(plaintext).toBe('still readable');
  });
});
