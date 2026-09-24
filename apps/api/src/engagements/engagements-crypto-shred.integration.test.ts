import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import { FakeKeyProvider } from '@fde/crypto';
import { createDbClient, engagements, tenants, withTenant, type Database } from '@fde/db';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeWorkOsService } from '../auth/fake-workos.service.js';

// Integration test — needs a migrated + hardened database, same convention as
// apps/api/src/seam.integration.test.ts:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

const tenantId = randomUUID() as TenantId;

// Must be in the environment before AppModule (→ @nestjs/config) is imported.
process.env.WORKOS_ORG_TENANT_MAP = JSON.stringify({ org_shred: tenantId });

const provider = new FakeKeyProvider();

async function seedEngagement(db: Database, name: string): Promise<EngagementId> {
  const engagementId = randomUUID() as EngagementId;
  const { wrappedDek } = await provider.generateDek({
    tenantId,
    engagementId,
    tenantCmkArn: 'fake:cmk',
  });
  await db.insert(engagements).values({
    id: engagementId,
    tenantId,
    endCustomerName: name,
    regionPin: 'us',
    retentionPolicy: 'full-retention',
    wrappedDek: Buffer.from(wrappedDek).toString('base64'),
  });
  return engagementId;
}

describe.skipIf(!url)('POST /engagements/:id/crypto-shred (integration)', () => {
  let handle: { db: Database; close: () => Promise<void> };
  let app: INestApplication;
  let closeApp: () => Promise<void>;
  let workos: FakeWorkOsService;
  let authz: InMemoryAuthzClient;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'Shred Co', cmkKeyRef: 'fake:t' });

    authz = new InMemoryAuthzClient();
    const { createTestApp } = await import('../test/harness.js');
    ({ app, workos, close: closeApp } = await createTestApp({ db: handle.db, authz }));
  });

  afterAll(async () => {
    await closeApp?.();
    if (handle) {
      await withTenant(handle.db, tenantId, (tx) =>
        tx.delete(engagements).where(eq(engagements.tenantId, tenantId)),
      );
      await handle.close();
    }
  });

  /** Runs the SSO dance and returns `{ token, userId }`. */
  async function login(
    code: string,
    workosUserId: string,
  ): Promise<{ token: string; userId: string }> {
    workos.register(code, {
      user: {
        id: workosUserId,
        email: `${workosUserId}@example.com`,
        firstName: 'T',
        lastName: 'U',
      },
      organizationId: 'org_shred',
    });
    const start = await request(app.getHttpServer()).get('/auth/login');
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const stateCookie = (start.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('fde_oauth_state='))!
      .split(';')[0]!;
    const res = await request(app.getHttpServer())
      .get(`/auth/callback?code=${code}&state=${state}`)
      .set('Cookie', stateCookie);
    const token = (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('fde_session='))!
      .slice('fde_session='.length)
      .split(';')[0]!;
    const me = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', `Bearer ${token}`);
    return { token, userId: me.body.userId as string };
  }

  async function readEngagement(id: EngagementId) {
    const [row] = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ status: engagements.status, wrappedDek: engagements.wrappedDek })
        .from(engagements)
        .where(eq(engagements.id, id)),
    );
    return row;
  }

  it('403s a caller who is neither an engagement admin nor a tenant admin — the engagement is left untouched', async () => {
    const engagementId = await seedEngagement(handle.db, 'Untouched Co');
    const { token } = await login('code-noauth', 'wos-noauth');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'trying to shred without authz' });

    expect(res.status).toBe(403);
    const row = await readEngagement(engagementId);
    expect(row?.status).toBe('active');
    expect(row?.wrappedDek).not.toBeNull();
  });

  it('400s a missing/empty reason for an otherwise-authorized caller — the engagement is left untouched', async () => {
    const engagementId = await seedEngagement(handle.db, 'Bad Body Co');
    const { token, userId } = await login('code-badbody', 'wos-badbody');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: '   ' });
    expect(res.status).toBe(400);

    const row = await readEngagement(engagementId);
    expect(row?.status).toBe('active');
    expect(row?.wrappedDek).not.toBeNull();
  });

  it('404s a caller reaching for an engagement outside their tenant', async () => {
    const otherTenantId = randomUUID() as TenantId;
    await handle.db
      .insert(tenants)
      .values({ id: otherTenantId, name: 'Other', cmkKeyRef: 'fake:o' });
    const otherEngagementId = randomUUID() as EngagementId;
    const { wrappedDek } = await provider.generateDek({
      tenantId: otherTenantId,
      engagementId: otherEngagementId,
      tenantCmkArn: 'fake:o',
    });
    await handle.db.insert(engagements).values({
      id: otherEngagementId,
      tenantId: otherTenantId,
      endCustomerName: 'Other Tenant Co',
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });

    const { token, userId } = await login('code-crosstenant', 'wos-crosstenant');
    await authz.grantEngagementRole(userId as never, otherEngagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${otherEngagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'cross-tenant attempt' });
    expect(res.status).toBe(404);

    await handle.db.delete(engagements).where(eq(engagements.tenantId, otherTenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, otherTenantId));
  });

  it('an engagement admin can shred; the response reflects it; Temporal is unconfigured in this test env and the shred still succeeds', async () => {
    const engagementId = await seedEngagement(handle.db, 'Real Shred Co');
    const { token, userId } = await login('code-admin', 'wos-admin');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'customer offboarded' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyShredded: false });

    const row = await readEngagement(engagementId);
    expect(row?.status).toBe('shredded');
    expect(row?.wrappedDek).toBeNull();
  });

  it('is idempotent: shredding an already-shredded engagement reports alreadyShredded and stays 200', async () => {
    const engagementId = await seedEngagement(handle.db, 'Twice Shred Co');
    const { token, userId } = await login('code-admin2', 'wos-admin2');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    const first = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'first' });
    expect(first.body).toEqual({ ok: true, alreadyShredded: false });

    const second = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'second' });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, alreadyShredded: true });
  });

  it('a tenant admin (no direct engagement role) can also shred', async () => {
    const engagementId = await seedEngagement(handle.db, 'Tenant Admin Co');
    const { token, userId } = await login('code-tenantadmin', 'wos-tenantadmin');
    await authz.grantTenantRole(userId as never, tenantId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'tenant admin cleanup' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, alreadyShredded: false });
  });

  it('after shredding, every other engagement route 410s instead of 500ing or leaking content', async () => {
    const engagementId = await seedEngagement(handle.db, 'Gone Co');
    const { token, userId } = await login('code-gone', 'wos-gone');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'gone' });

    const res = await request(app.getHttpServer())
      .get(`/engagements/${engagementId}/facts`)
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(410);
  });
});
