import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import {
  createDbClient,
  customIntegrations,
  type Database,
  engagements,
  entities,
  relationships,
  sources,
  tenants,
  users,
  withTenant,
} from '@fde/db';
import type { INestApplication } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FakeWorkOsService } from '../auth/fake-workos.service.js';
import { MAX_CUSTOM_INGEST_BYTES } from './integrations-ingest.controller.js';

// Integration test — needs a migrated + hardened database (same convention as
// seam.integration.test.ts). Skipped unless DATABASE_URL is set:
//   pnpm db:migrate && pnpm db:harden && DATABASE_URL=... pnpm vitest run <this file>
const url = process.env.DATABASE_URL;

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const engagementA = randomUUID() as EngagementId;
const engagementB = randomUUID() as EngagementId;

process.env.WORKOS_ORG_TENANT_MAP = JSON.stringify({ org_ci_a: tenantA, org_ci_b: tenantB });

const provider = new FakeKeyProvider();

const mapping = {
  artifact: {
    externalIdPath: 'ticket.id',
    kind: 'issue',
    occurredAtPath: 'ticket.createdAt',
    urlPermalinkPath: 'ticket.url',
  },
  entities: [
    {
      key: 'ticket',
      type: 'work_item',
      externalIdPath: 'ticket.id',
      displayNamePath: 'ticket.title',
      bodyPath: 'ticket.description',
      attributes: { status: 'ticket.status' },
    },
    {
      key: 'reporter',
      type: 'person',
      externalIdPath: 'ticket.reporter.id',
      displayNamePath: 'ticket.reporter.name',
    },
  ],
  relationships: [{ from: 'reporter', predicate: 'relates_to', to: 'ticket' }],
};

const payload = {
  ticket: {
    id: 'T-1',
    title: 'Printer on fire',
    description: 'There is smoke.',
    status: 'open',
    createdAt: '2026-01-02T03:04:05Z',
    url: 'https://example.com/t/1',
    reporter: { id: 'u-1', name: 'Ada' },
  },
};

async function seedEngagement(db: Database, tenantId: TenantId, id: EngagementId, name: string) {
  const { wrappedDek } = await provider.generateDek({
    tenantId,
    engagementId: id,
    tenantCmkArn: 'fake:cmk',
  });
  await db.insert(engagements).values({
    id,
    tenantId,
    endCustomerName: name,
    regionPin: 'us',
    retentionPolicy: 'full-retention',
    wrappedDek: Buffer.from(wrappedDek).toString('base64'),
  });
}

describe.skipIf(!url)('custom integrations (integration)', () => {
  let handle: { db: Database; close: () => Promise<void> };
  let app: INestApplication;
  let closeApp: () => Promise<void>;
  let workos: FakeWorkOsService;
  let tokenA: string;
  let tokenB: string;

  async function login(code: string, workosUserId: string, org: string): Promise<string> {
    workos.register(code, {
      user: {
        id: workosUserId,
        email: `${workosUserId}@example.com`,
        firstName: 'T',
        lastName: 'U',
      },
      organizationId: org,
    });
    const start = await request(app.getHttpServer()).get('/auth/login');
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const stateCookie = (start.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('fde_oauth_state='))!
      .split(';')[0]!;
    const res = await request(app.getHttpServer())
      .get(`/auth/callback?code=${code}&state=${state}`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(200);
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('fde_session='),
    )!;
    return cookie.slice('fde_session='.length).split(';')[0]!;
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'CI Tenant A', cmkKeyRef: 'fake:a' },
      { id: tenantB, name: 'CI Tenant B', cmkKeyRef: 'fake:b' },
    ]);
    await seedEngagement(handle.db, tenantA, engagementA, 'Acme');
    await seedEngagement(handle.db, tenantB, engagementB, 'Globex');

    const authz = new InMemoryAuthzClient();
    const { createTestApp } = await import('../test/harness.js');
    ({ app, workos, close: closeApp } = await createTestApp({ db: handle.db, authz }));

    tokenA = await login('ci-code-a', 'ci_wos_a', 'org_ci_a');
    tokenB = await login('ci-code-b', 'ci_wos_b', 'org_ci_b');
    for (const [tok, tenantId] of [
      [tokenA, tenantA],
      [tokenB, tenantB],
    ] as const) {
      const me = await request(app.getHttpServer())
        .get('/me')
        .set('authorization', `Bearer ${tok}`);
      await authz.grantTenantRole(me.body.userId as UserId, tenantId, 'admin');
    }
  });

  afterAll(async () => {
    await closeApp?.();
    if (!handle) return;
    // no RLS on custom_integrations; engagements cascade the rest
    for (const t of [tenantA, tenantB]) {
      await handle.db.delete(customIntegrations).where(eq(customIntegrations.tenantId, t));
      await withTenant(handle.db, t, (tx) =>
        tx.delete(engagements).where(eq(engagements.tenantId, t)),
      );
      await withTenant(handle.db, t, (tx) => tx.delete(users).where(eq(users.tenantId, t)));
    }
    await handle.close();
  });

  const http = () => request(app.getHttpServer());

  async function create(engagementId: EngagementId, token: string, name = 'Tickets') {
    const res = await http()
      .post(`/engagements/${engagementId}/integrations`)
      .set('authorization', `Bearer ${token}`)
      .send({ name, mapping });
    expect(res.status).toBe(201);
    return res.body as { id: string; secret: string; ingestUrl: string; secretPrefix: string };
  }

  const ingestPath = (engagementId: string, id: string) =>
    `/engagements/${engagementId}/integrations/${id}/ingest`;

  const graphFor = (tenantId: TenantId, engagementId: EngagementId) =>
    withTenant(handle.db, tenantId, async (tx) => ({
      ents: await tx.select().from(entities).where(eq(entities.engagementId, engagementId)),
      rels: await tx
        .select()
        .from(relationships)
        .where(eq(relationships.engagementId, engagementId)),
      srcs: await tx.select().from(sources).where(eq(sources.engagementId, engagementId)),
    }));

  it('create → ingest lands the mapped entities + relationship; re-POST dedupes', async () => {
    const it1 = await create(engagementA, tokenA);
    expect(it1.secret).toMatch(/^fdeci_/);
    expect(it1.ingestUrl).toContain(ingestPath(engagementA, it1.id));

    const first = await http()
      .post(ingestPath(engagementA, it1.id))
      .set('authorization', `Bearer ${it1.secret}`)
      .send(payload);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('accepted');

    const { ents, rels, srcs } = await graphFor(tenantA, engagementA);
    const mine = ents.filter((e) =>
      (e.externalRefs as { connector: string }[]).some((r) => r.connector === `custom:${it1.id}`),
    );
    expect(mine.map((e) => e.type).sort()).toEqual(['person', 'work_item']);
    expect(mine.map((e) => e.displayName).sort()).toEqual(['Ada', 'Printer on fire']);
    expect(rels.filter((r) => r.predicate === 'relates_to')).toHaveLength(1);
    expect(srcs.filter((s) => s.connector === `custom:${it1.id}`)).toHaveLength(1);

    const again = await http()
      .post(ingestPath(engagementA, it1.id))
      .set('authorization', `Bearer ${it1.secret}`)
      .send(payload);
    expect(again.status).toBe(200);
    const after = await graphFor(tenantA, engagementA);
    expect(after.ents).toHaveLength(ents.length);
    expect(after.rels).toHaveLength(rels.length);
    expect(after.srcs).toHaveLength(srcs.length);

    const list = await http()
      .get(`/engagements/${engagementA}/integrations`)
      .set('authorization', `Bearer ${tokenA}`);
    const listed = (list.body as { id: string; lastIngestedAt: string | null }[]).find(
      (i) => i.id === it1.id,
    );
    expect(listed?.lastIngestedAt).not.toBeNull();
    expect(JSON.stringify(list.body)).not.toContain(it1.secret);
  });

  it('no / wrong / malformed secret → 401', async () => {
    const i = await create(engagementA, tokenA);
    const url = ingestPath(engagementA, i.id);
    expect((await http().post(url).send(payload)).status).toBe(401);
    expect(
      (await http().post(url).set('authorization', 'Bearer fdeci_nope').send(payload)).status,
    ).toBe(401);
    expect((await http().post(url).set('authorization', 'Basic abc').send(payload)).status).toBe(
      401,
    );
  });

  it("tenant B's engagement URL + tenant A's integration id + the correct secret → 404", async () => {
    const i = await create(engagementA, tokenA);
    const wrong = await http()
      .post(ingestPath(engagementB, i.id))
      .set('authorization', `Bearer ${i.secret}`)
      .send(payload);
    expect(wrong.status).toBe(404);
    // indistinguishable from a nonexistent integration
    const missing = await http()
      .post(ingestPath(engagementB, randomUUID()))
      .set('authorization', `Bearer ${i.secret}`)
      .send(payload);
    expect(missing.status).toBe(404);
    expect(wrong.body.message).toBe(missing.body.message);
    expect((await graphFor(tenantB, engagementB)).ents).toHaveLength(0);
  });

  it("tenant B's admin cannot read, update, rotate or delete tenant A's integration", async () => {
    const i = await create(engagementA, tokenA);
    const base = `/engagements/${engagementB}/integrations/${i.id}`;
    const auth = { authorization: `Bearer ${tokenB}` };
    expect((await http().get(base).set(auth)).status).toBe(404);
    expect((await http().put(base).set(auth).send({ enabled: false })).status).toBe(404);
    expect((await http().post(`${base}/rotate-secret`).set(auth)).status).toBe(404);
    expect((await http().delete(base).set(auth)).status).toBe(404);
    // and it is still intact + usable for A
    const ok = await http()
      .post(ingestPath(engagementA, i.id))
      .set('authorization', `Bearer ${i.secret}`)
      .send(payload);
    expect(ok.status).toBe(200);
  });

  it('disabled integration + correct secret → 403; re-enabling restores it', async () => {
    const i = await create(engagementA, tokenA);
    const put = await http()
      .put(`/engagements/${engagementA}/integrations/${i.id}`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({ enabled: false });
    expect(put.status).toBe(200);
    const send = () =>
      http()
        .post(ingestPath(engagementA, i.id))
        .set('authorization', `Bearer ${i.secret}`)
        .send(payload);
    expect((await send()).status).toBe(403);
    await http()
      .put(`/engagements/${engagementA}/integrations/${i.id}`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({ enabled: true });
    expect((await send()).status).toBe(200);
  });

  it('rotate-secret invalidates the old secret; delete removes the integration', async () => {
    const i = await create(engagementA, tokenA);
    const rot = await http()
      .post(`/engagements/${engagementA}/integrations/${i.id}/rotate-secret`)
      .set('authorization', `Bearer ${tokenA}`);
    expect(rot.status).toBe(200);
    const url = ingestPath(engagementA, i.id);
    expect(
      (await http().post(url).set('authorization', `Bearer ${i.secret}`).send(payload)).status,
    ).toBe(401);
    expect(
      (await http().post(url).set('authorization', `Bearer ${rot.body.secret}`).send(payload))
        .status,
    ).toBe(200);

    const del = await http()
      .delete(`/engagements/${engagementA}/integrations/${i.id}`)
      .set('authorization', `Bearer ${tokenA}`);
    expect(del.status).toBe(204);
    expect(
      (await http().post(url).set('authorization', `Bearer ${rot.body.secret}`).send(payload))
        .status,
    ).toBe(404);
  });

  it('payloads that fail the mapping → 422 and nothing is written; non-JSON-object → 400', async () => {
    const i = await create(engagementA, tokenA);
    const before = await graphFor(tenantA, engagementA);
    const url = ingestPath(engagementA, i.id);
    const auth = { authorization: `Bearer ${i.secret}` };

    const noArtifactId = await http()
      .post(url)
      .set(auth)
      .send({ ticket: { ...payload.ticket, id: undefined } });
    expect(noArtifactId.status).toBe(422);
    expect(noArtifactId.body.issues[0].at).toBe('artifact.externalIdPath');

    const noReporter = await http()
      .post(url)
      .set(auth)
      .send({ ticket: { ...payload.ticket, id: 'T-9', reporter: {} } });
    expect(noReporter.status).toBe(422);

    expect(
      (await http().post(url).set(auth).set('content-type', 'application/json').send('[1]')).status,
    ).toBe(400);

    const after = await graphFor(tenantA, engagementA);
    expect(after.ents).toHaveLength(before.ents.length);
    expect(after.srcs).toHaveLength(before.srcs.length);
  });

  it('oversized body → 413', async () => {
    const i = await create(engagementA, tokenA);
    const res = await http()
      .post(ingestPath(engagementA, i.id))
      .set('authorization', `Bearer ${i.secret}`)
      .send({ ...payload, pad: 'x'.repeat(MAX_CUSTOM_INGEST_BYTES + 1) });
    expect(res.status).toBe(413);
  });

  it('POST …/integrations/test dry-runs without any db writes; bad mapping → 422', async () => {
    const countRows = async () =>
      (
        await handle.db
          .select()
          .from(customIntegrations)
          .where(eq(customIntegrations.tenantId, tenantA))
      ).length;
    const before = await countRows();
    const graphBefore = await graphFor(tenantA, engagementA);
    const res = await http()
      .post(`/engagements/${engagementA}/integrations/test`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({ mapping, payload: { ticket: { ...payload.ticket, reporter: {} } } });
    expect(res.status).toBe(200);
    expect(res.body.records).toHaveLength(1);
    expect(res.body.issues.length).toBeGreaterThan(0);
    expect(await countRows()).toBe(before);
    const graphAfter = await graphFor(tenantA, engagementA);
    expect(graphAfter.ents).toHaveLength(graphBefore.ents.length);

    const bad = await http()
      .post(`/engagements/${engagementA}/integrations/test`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({ mapping: { entities: [] }, payload: {} });
    expect(bad.status).toBe(422);
  });

  it('create with an invalid mapping → 422, no row', async () => {
    const res = await http()
      .post(`/engagements/${engagementA}/integrations`)
      .set('authorization', `Bearer ${tokenA}`)
      .send({ name: 'bad', mapping: { ...mapping, entities: [] } });
    expect(res.status).toBe(422);
  });
});
