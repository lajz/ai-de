import { randomUUID } from 'node:crypto';

import type { CanonicalEntity, EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { withEngagement } from './engagement.js';
import { resolveEndpointRef, upsertEntityByRef, upsertRelationship } from './graph-write.js';
import { engagements, entities, tenants } from './schema/index.js';

// Needs a migrated + hardened database — see packages/db/src/rls.integration.test.ts.
const url = process.env.DATABASE_URL;

const doc = (over: Partial<CanonicalEntity> = {}): CanonicalEntity => ({
  kind: 'entity',
  type: 'document',
  displayName: 'Design doc',
  externalRefs: [{ connector: 'fake', externalId: 'd1' }],
  attributes: {},
  ...over,
});

describe.skipIf(!url)('graph-write', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;
  const run = <T>(fn: Parameters<typeof withEngagement<T>>[3]) =>
    withEngagement(handle.db, provider, { tenantId, engagementId }, fn);

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
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('upsertEntityByRef inserts on a miss, then matches + merges on any shared ref', async () => {
    const a = await run((tx) =>
      upsertEntityByRef(
        tx,
        tenantId,
        engagementId,
        doc({ attributes: { status: 'draft' } }),
        getCipher(),
      ),
    );
    expect(a.created).toBe(true);

    const b = await run((tx) =>
      upsertEntityByRef(
        tx,
        tenantId,
        engagementId,
        doc({
          externalRefs: [
            { connector: 'fake', externalId: 'd1' },
            { connector: 'gdrive', externalId: 'g1' },
          ],
          attributes: { owner: 'ada' },
        }),
        getCipher(),
      ),
    );
    expect(b).toEqual({ entityId: a.entityId, created: false });

    const back = await run(async (tx) => {
      const [row] = await tx
        .select({ refs: entities.externalRefs, attributes: entities.attributes })
        .from(entities)
        .where(eq(entities.id, a.entityId));
      return {
        refs: row!.refs,
        attributes: await getCipher().decryptJson('entities.attributes', row!.attributes),
      };
    });
    expect(back.refs).toEqual([
      { connector: 'fake', externalId: 'd1' },
      { connector: 'gdrive', externalId: 'g1' },
    ]);
    expect(back.attributes).toEqual({ status: 'draft', owner: 'ada' });
  });

  it('upsertEntityByRef scopes the match by type', async () => {
    const asDoc = await run((tx) =>
      upsertEntityByRef(
        tx,
        tenantId,
        engagementId,
        doc({ externalRefs: [{ connector: 'fake', externalId: 'shared' }] }),
        getCipher(),
      ),
    );
    const asMeeting = await run((tx) =>
      upsertEntityByRef(
        tx,
        tenantId,
        engagementId,
        doc({ type: 'meeting', externalRefs: [{ connector: 'fake', externalId: 'shared' }] }),
        getCipher(),
      ),
    );
    expect(asMeeting.created).toBe(true);
    expect(asMeeting.entityId).not.toBe(asDoc.entityId);
  });

  it('upsertRelationship dedupes on the edge unique index', async () => {
    const from = randomUUID();
    const to = randomUUID();
    const edge = {
      fromKind: 'entity',
      fromId: from,
      predicate: 'relates_to',
      toKind: 'entity',
      toId: to,
    } as const;

    const first = await run((tx) =>
      upsertRelationship(tx, tenantId, engagementId, { ...edge, sourceId: null }),
    );
    const second = await run((tx) =>
      upsertRelationship(tx, tenantId, engagementId, { ...edge, sourceId: null }),
    );
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
  });

  it('resolveEndpointRef returns the entity on a hit, null on a miss', async () => {
    const ent = await run((tx) =>
      upsertEntityByRef(
        tx,
        tenantId,
        engagementId,
        doc({ type: 'work_item', externalRefs: [{ connector: 'linear', externalId: 'ISS-1' }] }),
        getCipher(),
      ),
    );
    const hit = await run((tx) =>
      resolveEndpointRef(tx, tenantId, engagementId, { connector: 'linear', externalId: 'ISS-1' }),
    );
    expect(hit).toEqual({ kind: 'entity', id: ent.entityId });

    const miss = await run((tx) =>
      resolveEndpointRef(tx, tenantId, engagementId, { connector: 'linear', externalId: 'nope' }),
    );
    expect(miss).toBeNull();
  });
});
