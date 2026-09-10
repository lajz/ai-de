import { randomUUID } from 'node:crypto';

import type { CanonicalEntity, EngagementId, EntityId, TenantId } from '@fde/core';
import { getCipher, FakeKeyProvider } from '@fde/crypto';
import {
  createDbClient,
  type Database,
  engagements,
  entities,
  tenants,
  withEngagement,
} from '@fde/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { IDENTITY_REF_DOMAIN, IDENTITY_REF_EMAIL, IDENTITY_REF_SSO } from './matching.js';
import { resolveEntity } from './resolve-entity.js';

// Needs a migrated + hardened database — see packages/db/src/rls.integration.test.ts.
const url = process.env.DATABASE_URL;

const person = (over: Partial<CanonicalEntity> = {}): CanonicalEntity => ({
  kind: 'entity',
  type: 'person',
  displayName: 'Jane Smith',
  externalRefs: [{ connector: 'jira', externalId: 'jsmith' }],
  attributes: {},
  ...over,
});

describe.skipIf(!url)('resolveEntity', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;

  const run = <T>(fn: Parameters<typeof withEngagement<T>>[3]) =>
    withEngagement(handle.db, provider, { tenantId, engagementId }, fn);

  const readBack = (id: EntityId) =>
    run(async (tx) => {
      const [row] = await tx
        .select({ refs: entities.externalRefs, attributes: entities.attributes })
        .from(entities)
        .where(eq(entities.id, id));
      return {
        refs: row!.refs,
        attributes: await getCipher().decryptJson<Record<string, unknown>>(
          'entities.attributes',
          row!.attributes,
        ),
      };
    });

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

  it('creates a new entity when nothing matches', async () => {
    const res = await run((tx) => resolveEntity(tx, tenantId, engagementId, person()));
    expect(res.created).toBe(true);
    expect(res.matchedBy).toBeNull();
  });

  it('merges on an exact external ref — unions refs, shallow-merges attributes', async () => {
    const first = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          externalRefs: [{ connector: 'slack', externalId: 'U-EXACT' }],
          attributes: { title: 'PM' },
        }),
      ),
    );
    const second = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          externalRefs: [
            { connector: 'slack', externalId: 'U-EXACT' },
            { connector: 'jira', externalId: 'j-EXACT' },
          ],
          attributes: { team: 'Platform' },
        }),
      ),
    );
    expect(second.entityId).toBe(first.entityId);
    expect(second.created).toBe(false);
    expect(second.matchedBy).toBe('externalRef');

    const back = await readBack(first.entityId);
    expect(back.refs).toEqual([
      { connector: 'slack', externalId: 'U-EXACT' },
      { connector: 'jira', externalId: 'j-EXACT' },
    ]);
    expect(back.attributes).toEqual({ title: 'PM', team: 'Platform' });
  });

  it('merges on a normalized email', async () => {
    const a = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          externalRefs: [{ connector: IDENTITY_REF_EMAIL, externalId: 'Bob+news@Acme.com' }],
        }),
      ),
    );
    const b = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          externalRefs: [{ connector: IDENTITY_REF_EMAIL, externalId: 'bob@acme.com' }],
        }),
      ),
    );
    expect(b.entityId).toBe(a.entityId);
    expect(b.matchedBy).toBe('email');
  });

  it('merges on an SSO subject', async () => {
    const a = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({ externalRefs: [{ connector: IDENTITY_REF_SSO, externalId: 'okta|123' }] }),
      ),
    );
    const b = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          displayName: 'J. Smith',
          externalRefs: [{ connector: IDENTITY_REF_SSO, externalId: 'okta|123' }],
        }),
      ),
    );
    expect(b.entityId).toBe(a.entityId);
    expect(b.matchedBy).toBe('sso');
  });

  it('merges an organization on its normalized domain but not a person', async () => {
    const org = (id: string) =>
      person({
        type: 'organization',
        displayName: 'Acme',
        externalRefs: [{ connector: IDENTITY_REF_DOMAIN, externalId: id }],
      });
    const a = await run((tx) =>
      resolveEntity(tx, tenantId, engagementId, org('https://www.acme.com/')),
    );
    const b = await run((tx) => resolveEntity(tx, tenantId, engagementId, org('acme.com')));
    expect(b.entityId).toBe(a.entityId);
    expect(b.matchedBy).toBe('domain');

    // a person carrying only a domain ref never matches on it
    const p1 = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({ externalRefs: [{ connector: IDENTITY_REF_DOMAIN, externalId: 'acme.com' }] }),
      ),
    );
    const p2 = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({ externalRefs: [{ connector: IDENTITY_REF_DOMAIN, externalId: 'acme.com' }] }),
      ),
    );
    expect(p2.entityId).not.toBe(p1.entityId);
    expect(p2.created).toBe(true);
  });

  it('when keys match different entities, the highest-priority tier wins (v1)', async () => {
    const byEmail = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({ externalRefs: [{ connector: IDENTITY_REF_EMAIL, externalId: 'al@corp.com' }] }),
      ),
    );
    const byRef = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({ externalRefs: [{ connector: 'jira', externalId: 'al-jira' }] }),
      ),
    );
    expect(byRef.entityId).not.toBe(byEmail.entityId);

    // incoming carries both keys — exact ref (tier 1) beats email (tier 2)
    const both = await run((tx) =>
      resolveEntity(
        tx,
        tenantId,
        engagementId,
        person({
          externalRefs: [
            { connector: 'jira', externalId: 'al-jira' },
            { connector: IDENTITY_REF_EMAIL, externalId: 'al@corp.com' },
          ],
        }),
      ),
    );
    expect(both.entityId).toBe(byRef.entityId);
    expect(both.matchedBy).toBe('externalRef');
    // the email-only entity is untouched — v1 does not reconcile the two here
    const survivor = await readBack(byEmail.entityId);
    expect(survivor.refs).toEqual([{ connector: IDENTITY_REF_EMAIL, externalId: 'al@corp.com' }]);
  });
});
