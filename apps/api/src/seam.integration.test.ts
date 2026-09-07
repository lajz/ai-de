import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import { createDbClient, type Database, engagements, tenants, users, withTenant } from '@fde/db';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeWorkOsService } from './auth/fake-workos.service.js';
import { TEST_WEBHOOK_SECRET } from './test/harness.js';

// Integration test — needs a migrated + hardened database, same convention as
// packages/db/src/*.integration.test.ts. Skipped unless DATABASE_URL is set:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm test
const url = process.env.DATABASE_URL;

const tenantA = randomUUID() as TenantId;
const tenantB = randomUUID() as TenantId;
const engagementA = randomUUID() as EngagementId;
const engagementB = randomUUID() as EngagementId;

// Must be in the environment before AppModule (→ @nestjs/config) is imported.
process.env.WORKOS_ORG_TENANT_MAP = JSON.stringify({ org_a: tenantA, org_b: tenantB });

const provider = new FakeKeyProvider();

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

function loginCode(workos: FakeWorkOsService, code: string, workosUserId: string, org: string) {
  workos.register(code, {
    user: { id: workosUserId, email: `${workosUserId}@example.com`, firstName: 'T', lastName: 'U' },
    organizationId: org,
  });
}

describe.skipIf(!url)('apps/api request-context seam (integration)', () => {
  let handle: { db: Database; close: () => Promise<void> };
  let app: INestApplication;
  let closeApp: () => Promise<void>;
  let workos: FakeWorkOsService;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    // seed on the superuser connection (bypasses RLS)
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'Tenant A', cmkKeyRef: 'fake:a' },
      { id: tenantB, name: 'Tenant B', cmkKeyRef: 'fake:b' },
    ]);
    await seedEngagement(handle.db, tenantA, engagementA, 'Acme');
    await seedEngagement(handle.db, tenantB, engagementB, 'Globex');

    const { createTestApp } = await import('./test/harness.js');
    ({ app, workos, close: closeApp } = await createTestApp({ db: handle.db }));
  });

  afterAll(async () => {
    await closeApp?.();
    if (handle) {
      // access_log is append-only; dropping engagements cascades their content.
      await withTenant(handle.db, tenantA, (tx) =>
        tx.delete(engagements).where(eq(engagements.tenantId, tenantA)),
      );
      await withTenant(handle.db, tenantB, (tx) =>
        tx.delete(engagements).where(eq(engagements.tenantId, tenantB)),
      );
      await withTenant(handle.db, tenantA, (tx) =>
        tx.delete(users).where(eq(users.tenantId, tenantA)),
      );
      await handle.close();
    }
  });

  /** Runs the full SSO dance (login → state cookie → callback) and returns the session token. */
  async function login(code: string, workosUserId: string, org: string): Promise<string> {
    loginCode(workos, code, workosUserId, org);
    const start = await request(app.getHttpServer()).get('/auth/login');
    const state = new URL(start.headers.location).searchParams.get('state')!;
    const stateCookie = (start.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('fde_oauth_state='))!
      .split(';')[0]!;

    const res = await request(app.getHttpServer())
      .get(`/auth/callback?code=${code}&state=${state}`)
      .set('Cookie', stateCookie);
    expect(res.status).toBe(200);

    const sessionCookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('fde_session='),
    )!;
    return sessionCookie.slice('fde_session='.length).split(';')[0]!;
  }

  it('SSO callback upserts the user and /me reads it back through the tenant tx', async () => {
    const token = await login('code-a', 'wos_a', 'org_a');
    const res = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tenantId: tenantA,
      email: 'wos_a@example.com',
      status: 'active',
    });
  });

  it('GET /engagements is RLS-scoped to the caller tenant', async () => {
    const token = await login('code-a2', 'wos_a', 'org_a');
    const res = await request(app.getHttpServer())
      .get('/engagements')
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toContain(engagementA);
    expect(ids).not.toContain(engagementB);
  });

  it('GET /engagements/:id/audit returns the log and records its own content_read', async () => {
    const token = await login('code-a3', 'wos_a', 'org_a');
    const first = await request(app.getHttpServer())
      .get(`/engagements/${engagementA}/audit`)
      .set('authorization', `Bearer ${token}`);
    expect(first.status).toBe(200);

    const second = await request(app.getHttpServer())
      .get(`/engagements/${engagementA}/audit`)
      .set('authorization', `Bearer ${token}`);
    expect(second.status).toBe(200);
    const actions = (second.body.rows as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain('content_read');
  });

  it("tenant A cannot reach tenant B's engagement audit (404 via RLS)", async () => {
    const token = await login('code-a4', 'wos_a', 'org_a');
    const res = await request(app.getHttpServer())
      .get(`/engagements/${engagementB}/audit`)
      .set('authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });

  it("tenant B's session sees only tenant B's engagements", async () => {
    const token = await login('code-b', 'wos_b', 'org_b');
    const res = await request(app.getHttpServer())
      .get('/engagements')
      .set('authorization', `Bearer ${token}`);
    const ids = (res.body as Array<{ id: string }>).map((e) => e.id);
    expect(ids).toEqual([engagementB]);
  });

  it('SCIM deprovision disables the user and revokes the session', async () => {
    const token = await login('code-a5', 'wos_a', 'org_a');
    expect(
      (await request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`))
        .status,
    ).toBe(200);

    const body = JSON.stringify({
      id: 'evt_x',
      event: 'dsync.user.deleted',
      data: { id: 'wos_a', organization_id: 'org_a' },
    });
    const hook = await request(app.getHttpServer())
      .post('/webhooks/workos')
      .set('content-type', 'application/json')
      .set('workos-signature', FakeWorkOsService.signWebhook(body, TEST_WEBHOOK_SECRET))
      .send(body);
    expect(hook.status).toBe(201);
    expect(hook.body).toMatchObject({ action: 'deprovisioned' });

    // the old session is now dead
    expect(
      (await request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`))
        .status,
    ).toBe(401);

    const [row] = await withTenant(handle.db, tenantA, (tx) =>
      tx.select({ status: users.status }).from(users).where(eq(users.workosUserId, 'wos_a')),
    );
    expect(row?.status).toBe('disabled');
  });
});
