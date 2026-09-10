import { randomUUID } from 'node:crypto';

import type { CanonicalEntity, EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import {
  accessLog,
  createDbClient,
  type Database,
  engagements,
  entities,
  identityReviewQueue,
  relationships,
  tenants,
  withEngagement,
  withTenant,
} from '@fde/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { findMatchCandidates } from './candidates.js';
import { IDENTITY_REF_EMAIL } from './matching.js';
import { resolveEntity } from './resolve-entity.js';
import { applyMatchDecision, listPendingMatches } from './review-queue.js';

const url = process.env.DATABASE_URL;

const person = (displayName: string, email: string, ref: string): CanonicalEntity => ({
  kind: 'entity',
  type: 'person',
  displayName,
  externalRefs: [
    { connector: 'src', externalId: ref },
    { connector: IDENTITY_REF_EMAIL, externalId: email },
  ],
  attributes: {},
});

describe.skipIf(!url)('identity review queue', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;

  const engagement2Id = randomUUID() as EngagementId;

  const mkPerson = (name: string, email: string, ref: string, eng: EngagementId = engagementId) =>
    withEngagement(handle.db, provider, { tenantId, engagementId: eng }, (tx) =>
      resolveEntity(tx, tenantId, eng, person(name, email, ref)),
    ).then((r) => r.entityId);

  const asTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(handle.db, tenantId, fn);

  const seedEngagement = async (id: EngagementId, name: string) => {
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId: id,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id,
      tenantId,
      endCustomerName: name,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
  };

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
    await seedEngagement(engagementId, 'Acme');
    await seedEngagement(engagement2Id, 'Beta');
  });

  afterAll(async () => {
    // drop engagements (cascades to entities / relationships / identity_review_queue);
    // access_log is append-only + FK-restricts tenants, so the throwaway tenant and
    // its audit rows are left behind — this suite expects a disposable database.
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('returns nothing for a non-person or a person with no peers', async () => {
    const org = await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      resolveEntity(tx, tenantId, engagementId, {
        kind: 'entity',
        type: 'organization',
        displayName: 'Solo Corp',
        externalRefs: [{ connector: 'src', externalId: 'solo-org' }],
        attributes: {},
      }),
    ).then((r) => r.entityId);
    const lone = await mkPerson('Only Person', 'only@nowhere.test', 'solo1');

    expect(await asTenant((tx) => findMatchCandidates(tx, tenantId, org))).toEqual([]);
    expect(await asTenant((tx) => findMatchCandidates(tx, tenantId, lone))).toEqual([]);
  });

  it('queues a near-duplicate, skips a clearly different person, and merges FKs', async () => {
    const a = await mkPerson('Jane Smith', 'jane@acme.com', 'a1');
    const b = await mkPerson('Jayne Smith', 'jayne@acme.com', 'b1');
    await mkPerson('Robert Jones', 'rjones@acme.com', 'c1');

    // an org B belongs to — the edge must follow the merge onto A
    const orgId = await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      resolveEntity(tx, tenantId, engagementId, {
        kind: 'entity',
        type: 'organization',
        displayName: 'Acme',
        externalRefs: [{ connector: 'src', externalId: 'acme-org' }],
        attributes: {},
      }),
    ).then((r) => r.entityId);
    await asTenant((tx) =>
      tx.insert(relationships).values({
        tenantId,
        engagementId,
        fromKind: 'entity',
        fromId: b,
        predicate: 'member_of',
        toKind: 'entity',
        toId: orgId,
      }),
    );

    const candidates = await asTenant((tx) => findMatchCandidates(tx, tenantId, b));
    expect(candidates.map((c) => c.entityId)).toEqual([a]);
    expect(candidates[0]!.queued).toBe(true);
    expect(candidates[0]!.signals.sharedDomain).toBe(true);

    const pending = await asTenant((tx) => listPendingMatches(tx, tenantId));
    expect(pending).toHaveLength(1);
    const queueId = pending[0]!.id;

    const res = await asTenant((tx) =>
      applyMatchDecision(tx, tenantId, {
        queueId,
        decision: 'merge',
        decidedBy: 'reviewer-1',
        keepEntityId: a,
      }),
    );
    expect(res.decision).toBe('merge');
    expect(res.keptEntityId).toBe(a);
    expect(res.mergedEntityId).toBe(b);
    expect(res.repointedRelationships).toBe(1);

    await asTenant(async (tx) => {
      // dropped entity is gone; the queue row cascaded away
      expect(await tx.select().from(entities).where(eq(entities.id, res.mergedEntityId!))).toEqual(
        [],
      );
      expect(await listPendingMatches(tx, tenantId)).toEqual([]);

      // B's refs were unioned onto A
      const [kept] = await tx
        .select({ refs: entities.externalRefs })
        .from(entities)
        .where(eq(entities.id, res.keptEntityId!));
      expect(kept!.refs).toContainEqual({ connector: 'src', externalId: 'b1' });

      // the member_of edge now starts at A
      const edges = await tx
        .select({ fromId: relationships.fromId })
        .from(relationships)
        .where(and(eq(relationships.predicate, 'member_of'), eq(relationships.toId, orgId)));
      expect(edges).toEqual([{ fromId: res.keptEntityId }]);

      const log = await tx
        .select({ action: accessLog.action, decision: accessLog.authzDecision })
        .from(accessLog)
        .where(eq(accessLog.action, 'identity_merge'));
      expect(log).toHaveLength(1);
      expect((log[0]!.decision as { decision: string }).decision).toBe('merge');
    });
  });

  it('reject records the negative so the pair is not re-queued, and is audited', async () => {
    const d = await mkPerson('Chris Green', 'chris@beta.io', 'd1');
    await mkPerson('Kris Green', 'kris@beta.io', 'e1');

    const first = await asTenant((tx) => findMatchCandidates(tx, tenantId, d));
    expect(first[0]!.queued).toBe(true);

    const [queued] = await asTenant((tx) => listPendingMatches(tx, tenantId));
    await asTenant((tx) =>
      applyMatchDecision(tx, tenantId, {
        queueId: queued!.id,
        decision: 'reject',
        decidedBy: 'reviewer-1',
      }),
    );

    expect(await asTenant((tx) => listPendingMatches(tx, tenantId))).toEqual([]);

    const again = await asTenant((tx) => findMatchCandidates(tx, tenantId, d));
    expect(again[0]!.queued).toBe(false);

    await asTenant(async (tx) => {
      const rejected = await tx
        .select({ status: identityReviewQueue.status })
        .from(identityReviewQueue)
        .where(eq(identityReviewQueue.tenantId, tenantId));
      expect(rejected).toContainEqual({ status: 'rejected' });

      const log = await tx
        .select({ decision: accessLog.authzDecision })
        .from(accessLog)
        .where(eq(accessLog.action, 'identity_merge'));
      expect(log.some((r) => (r.decision as { decision: string }).decision === 'reject')).toBe(
        true,
      );
    });
  });

  it('refuses to merge a cross-engagement pair but still lets it be rejected', async () => {
    const here = await mkPerson('Dana White', 'dana@gamma.io', 'g1');
    await mkPerson('Dana Whyte', 'dana2@gamma.io', 'g2', engagement2Id);

    await asTenant((tx) => findMatchCandidates(tx, tenantId, here));
    const [pair] = await asTenant((tx) => listPendingMatches(tx, tenantId));

    await expect(
      asTenant((tx) =>
        applyMatchDecision(tx, tenantId, {
          queueId: pair!.id,
          decision: 'merge',
          decidedBy: 'reviewer-1',
        }),
      ),
    ).rejects.toThrow(/cross-engagement/i);

    const res = await asTenant((tx) =>
      applyMatchDecision(tx, tenantId, {
        queueId: pair!.id,
        decision: 'reject',
        decidedBy: 'reviewer-1',
      }),
    );
    expect(res.status).toBe('rejected');
  });
});
