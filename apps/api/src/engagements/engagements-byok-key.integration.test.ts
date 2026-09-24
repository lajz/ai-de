import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import { FakeKeyProvider } from '@fde/crypto';
import { createDbClient, engagements, tenants, withTenant, type Database } from '@fde/db';
import { eq, sql } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeWorkOsService } from '../auth/fake-workos.service.js';

// Integration test — needs a migrated + hardened database, same convention as
// `engagements-crypto-shred.integration.test.ts`:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

const tenantId = randomUUID() as TenantId;

// Must be in the environment before AppModule (→ @nestjs/config) is imported.
process.env.WORKOS_ORG_TENANT_MAP = JSON.stringify({ org_byok: tenantId });

const provider = new FakeKeyProvider();

const VALID_ARN = 'arn:aws:kms:us-east-1:111122223333:key/1234abcd-12ab-34cd-56ef-1234567890ab';
const OTHER_VALID_ARN =
  'arn:aws:kms:us-east-1:111122223333:key/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

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

describe.skipIf(!url)('POST /engagements/:id/crypto/byok-key (integration)', () => {
  let handle: { db: Database; close: () => Promise<void> };
  let app: INestApplication;
  let closeApp: () => Promise<void>;
  let workos: FakeWorkOsService;
  let authz: InMemoryAuthzClient;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'BYOK Co', cmkKeyRef: 'fake:t' });

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
      organizationId: 'org_byok',
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
        .select({
          status: engagements.status,
          wrappedDek: engagements.wrappedDek,
          byokKeyArn: engagements.byokKeyArn,
        })
        .from(engagements)
        .where(eq(engagements.id, id)),
    );
    return row;
  }

  it('403s a caller who is neither an engagement admin nor a tenant admin — the engagement is left untouched', async () => {
    const engagementId = await seedEngagement(handle.db, 'Untouched Co');
    const { token } = await login('code-byok-noauth', 'wos-byok-noauth');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: VALID_ARN });

    expect(res.status).toBe(403);
    const row = await readEngagement(engagementId);
    expect(row?.byokKeyArn).toBeNull();
  });

  it('400s a malformed ARN for an otherwise-authorized caller, before any KMS call', async () => {
    const engagementId = await seedEngagement(handle.db, 'Bad ARN Co');
    const { token, userId } = await login('code-byok-badarn', 'wos-byok-badarn');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: 'not-an-arn' });

    expect(res.status).toBe(400);
    const row = await readEngagement(engagementId);
    expect(row?.byokKeyArn).toBeNull();
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

    const { token, userId } = await login('code-byok-crosstenant', 'wos-byok-crosstenant');
    await authz.grantEngagementRole(userId as never, otherEngagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${otherEngagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: VALID_ARN });
    expect(res.status).toBe(404);

    await handle.db.delete(engagements).where(eq(engagements.tenantId, otherTenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, otherTenantId));
  });

  it('an engagement admin can set BYOK; the engagement now carries the new key ARN and an audit row', async () => {
    const engagementId = await seedEngagement(handle.db, 'Real BYOK Co');
    const { token, userId } = await login('code-byok-admin', 'wos-byok-admin');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: VALID_ARN });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, byokKeyArn: VALID_ARN });

    const row = await readEngagement(engagementId);
    expect(row?.byokKeyArn).toBe(VALID_ARN);

    const auditRows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ action: sql<string>`action` })
        .from(sql`access_log`)
        .where(sql`engagement_id = ${engagementId} and action = 'byok_key_rotated'`),
    );
    expect(auditRows).toHaveLength(1);
  });

  it('a tenant admin (no direct engagement role) can also set BYOK, and it can be rotated again to a second key', async () => {
    const engagementId = await seedEngagement(handle.db, 'Tenant Admin BYOK Co');
    const { token, userId } = await login('code-byok-tenantadmin', 'wos-byok-tenantadmin');
    await authz.grantTenantRole(userId as never, tenantId, 'admin');

    const first = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: VALID_ARN });
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: OTHER_VALID_ARN });
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, byokKeyArn: OTHER_VALID_ARN });

    const row = await readEngagement(engagementId);
    expect(row?.byokKeyArn).toBe(OTHER_VALID_ARN);
  });

  it('410s an attempt to set BYOK on an already crypto-shredded engagement', async () => {
    const engagementId = await seedEngagement(handle.db, 'Shredded Co');
    const { token, userId } = await login('code-byok-shredded', 'wos-byok-shredded');
    await authz.grantEngagementRole(userId as never, engagementId, 'admin');

    await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto-shred`)
      .set('authorization', `Bearer ${token}`)
      .send({ reason: 'offboarded before BYOK attempt' });

    const res = await request(app.getHttpServer())
      .post(`/engagements/${engagementId}/crypto/byok-key`)
      .set('authorization', `Bearer ${token}`)
      .send({ byokKeyArn: VALID_ARN });

    expect(res.status).toBe(410);
  });
});
