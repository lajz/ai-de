import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import { createDbClient, engagements, tenants, type Database } from '@fde/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withEngagementActivity } from './engagement-context.js';

// Integration test — needs a migrated + hardened database, same as
// packages/db/src/engagement.test.ts. Skipped unless DATABASE_URL is set.
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('withEngagementActivity', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: 'Acme',
      regionPin: 'us',
      retentionPolicy: 'derived-ephemeral-raw',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
  });

  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('hands the cipher to fn explicitly, not via AsyncLocalStorage', async () => {
    const seen = await withEngagementActivity(
      handle.db,
      provider,
      { tenantId, engagementId },
      async (ctx) => {
        expect(ctx.tenantId).toBe(tenantId);
        expect(ctx.engagementId).toBe(engagementId);
        // proves the cipher is live and usable inside fn, entirely from the
        // explicit argument
        const ciphertext = await ctx.cipher.encryptString('facts.body', 'hello');
        const plaintext = await ctx.cipher.decryptString('facts.body', ciphertext);
        return plaintext;
      },
    );
    expect(seen).toBe('hello');
  });
});
