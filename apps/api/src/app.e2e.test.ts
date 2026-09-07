import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeWorkOsService } from './auth/fake-workos.service.js';
import { createTestApp, TEST_WEBHOOK_SECRET } from './test/harness.js';

/**
 * Seam-surface e2e — no database. A stub `DB` that throws proves the guard
 * rejects unauthenticated requests *before* the interceptor opens a transaction.
 * The DB-backed happy path + cross-tenant isolation live in
 * `seam.integration.test.ts` (needs DATABASE_URL).
 */
const throwingDb = {
  transaction: () => {
    throw new Error('DB must not be touched on this path');
  },
};

describe('apps/api e2e (no DB)', () => {
  let app: INestApplication;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ app, close } = await createTestApp({ db: throwingDb }));
  });

  afterAll(() => close());

  it('GET /healthz → 200 without auth or DB', async () => {
    const res = await request(app.getHttpServer()).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });

  it('GET /me without credentials → 401 (before any DB work)', async () => {
    const res = await request(app.getHttpServer()).get('/me');
    expect(res.status).toBe(401);
  });

  it('GET /engagements without credentials → 401', async () => {
    expect((await request(app.getHttpServer()).get('/engagements')).status).toBe(401);
  });

  it('GET /engagements/:id/audit without credentials → 401', async () => {
    const res = await request(app.getHttpServer()).get(`/engagements/${randomUUID()}/audit`);
    expect(res.status).toBe(401);
  });

  it('GET /me with an unknown bearer token → 401', async () => {
    const res = await request(app.getHttpServer())
      .get('/me')
      .set('authorization', 'Bearer not-a-real-session');
    expect(res.status).toBe(401);
  });

  it('GET /auth/login → 302 to the WorkOS authorization URL', async () => {
    const res = await request(app.getHttpServer()).get('/auth/login?state=xyz');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('fake-workos.local');
    expect(res.headers.location).toContain('state=xyz');
  });

  describe('POST /webhooks/workos', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      event: 'dsync.user.deleted',
      data: { id: 'wos_user_1', organization_id: 'org_unmapped' },
    });

    it('rejects a missing signature → 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/workos')
        .set('content-type', 'application/json')
        .send(body);
      expect(res.status).toBe(401);
    });

    it('rejects a bad signature → 401', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/workos')
        .set('content-type', 'application/json')
        .set('workos-signature', 't=1, v1=deadbeef')
        .send(body);
      expect(res.status).toBe(401);
    });

    it('accepts a valid signature and ignores an unmapped org (no DB)', async () => {
      const res = await request(app.getHttpServer())
        .post('/webhooks/workos')
        .set('content-type', 'application/json')
        .set('workos-signature', FakeWorkOsService.signWebhook(body, TEST_WEBHOOK_SECRET))
        .send(body);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ action: 'ignored' });
    });
  });
});
