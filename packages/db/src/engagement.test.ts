import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { getCipher, FakeKeyProvider } from '@fde/crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { shredEngagement, withEngagement } from './engagement.js';
import { withTenant } from './rls.js';
import { engagements, facts, tenants } from './schema/index.js';

// Integration test — needs a migrated + hardened database. Skipped unless
// DATABASE_URL is set:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('withEngagement / shredEngagement', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  // Each test gets its own engagement so nothing (e.g. a shred) leaks across.
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
      retentionPolicy: 'derived-ephemeral-raw',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    // seed on a superuser connection (DATABASE_URL points at `postgres`), which
    // bypasses RLS — every table here, tenants included, is FORCE RLS.
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });

  afterAll(async () => {
    // Never DELETE from access_log — it is append-only. Dropping the engagements
    // cascades to their content rows and, via ON DELETE SET NULL, leaves any
    // crypto_shred audit row in place (nulled engagement_id), which is the
    // behaviour we want. The throwaway tenant + those audit rows are left
    // behind; this suite expects a disposable database.
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('writes and reads back an encrypted fact body through the crypto context', async () => {
    const engagementId = await seedEngagement();
    const factId = randomUUID();

    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const body = await getCipher().encryptString('facts.body', 'customer chose Postgres');
      await tx.insert(facts).values({
        id: factId,
        tenantId,
        engagementId,
        type: 'decision',
        summary: 'db choice',
        body,
      });
    });

    // stored as ciphertext (not the plaintext bytes)
    const [raw] = await handle.db
      .select({ body: sql<Buffer>`${facts.body}` })
      .from(facts)
      .where(eq(facts.id, factId));
    expect(raw!.body.toString('utf8')).not.toContain('Postgres');

    const plaintext = await withEngagement(
      handle.db,
      provider,
      { tenantId, engagementId },
      async (tx) => {
        const [row] = await tx.select({ body: facts.body }).from(facts).where(eq(facts.id, factId));
        return getCipher().decryptString('facts.body', row!.body!);
      },
    );
    expect(plaintext).toBe('customer chose Postgres');
  });

  it('throws when the engagement does not exist', async () => {
    await expect(
      withEngagement(
        handle.db,
        provider,
        { tenantId, engagementId: randomUUID() as EngagementId },
        async () => undefined,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('crypto-shred makes the engagement unreadable and is logged', async () => {
    const engagementId = await seedEngagement();

    const did = await shredEngagement(handle.db, {
      tenantId,
      engagementId,
      actorId: 'admin-1',
      reason: 'customer offboarded',
    });
    expect(did).toBe(true);

    await expect(
      withEngagement(handle.db, provider, { tenantId, engagementId }, async () => undefined),
    ).rejects.toThrow(/shred/i);

    const shredLog = () =>
      withTenant(handle.db, tenantId, (tx) =>
        tx
          .select({ action: sql<string>`action` })
          .from(sql`access_log`)
          .where(sql`engagement_id = ${engagementId} and action = 'crypto_shred'`),
      );
    expect(await shredLog()).toHaveLength(1);

    // second shred is a no-op — and writes no second audit row
    expect(
      await shredEngagement(handle.db, {
        tenantId,
        engagementId,
        actorId: 'admin-1',
        reason: 'again',
      }),
    ).toBe(false);
    expect(await shredLog()).toHaveLength(1);
  });

  it('two concurrent shreds: exactly one wins, exactly one audit row', async () => {
    const engagementId = await seedEngagement();
    const shred = (reason: string) =>
      shredEngagement(handle.db, { tenantId, engagementId, actorId: 'admin-1', reason });

    const results = await Promise.all([shred('race-a'), shred('race-b')]);
    expect(results.filter(Boolean)).toHaveLength(1);

    const rows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ n: sql<number>`count(*)::int` })
        .from(sql`access_log`)
        .where(sql`engagement_id = ${engagementId} and action = 'crypto_shred'`),
    );
    expect(rows[0]?.n).toBe(1);
  });
});
