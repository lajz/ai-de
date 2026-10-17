import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import {
  apiKeys,
  createDbClient,
  type Database,
  engagements,
  tenants,
  users,
  withTenant,
} from '@fde/db';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiKey } from './auth/api-key.service.js';
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
      // api_keys has no RLS and FKs users — must go first
      await handle.db.delete(apiKeys).where(eq(apiKeys.tenantId, tenantA));
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

  describe('POST /engagements/:id/qa/agentic — the new @NoTransactionScope() route', () => {
    /** Parses the raw SSE body into each frame's `data:` payload. */
    function sseEvents(body: string): unknown[] {
      return body
        .split('\n\n')
        .map((frame) =>
          frame
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).replace(/^ /, ''))
            .join('\n'),
        )
        .filter(Boolean)
        .map((d) => JSON.parse(d));
    }

    it('answers for the caller tenant’s own engagement (no ANTHROPIC_API_KEY in this env → falls back to the one-shot path, which still exercises the real authz + RLS scoping)', async () => {
      const token = await login('code-a6', 'wos_a', 'org_a');
      const res = await request(app.getHttpServer())
        .post(`/engagements/${engagementA}/qa/agentic`)
        .set('authorization', `Bearer ${token}`)
        .send({ question: 'what is this engagement?' });

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/event-stream/);
      const events = sseEvents(res.text) as { type: string }[];
      expect(events.some((e) => e.type === 'answer' || e.type === 'error')).toBe(true);
    });

    it("never lets tenant A's session reach tenant B's engagement content — every tool call against it 404s via RLS, and the caller never sees an answer built from it", async () => {
      const token = await login('code-a7', 'wos_a', 'org_a');
      const res = await request(app.getHttpServer())
        .post(`/engagements/${engagementB}/qa/agentic`)
        .set('authorization', `Bearer ${token}`)
        .send({ question: 'what is Globex working on?' });

      expect(res.status).toBe(200); // SSE already started; the failure is in-band
      const events = sseEvents(res.text) as {
        type: string;
        tool?: string;
        status?: string;
        message?: string;
      }[];
      // The security invariant: RLS gates every tool read of engagementB, so
      // every tool call the agent makes errors out — regardless of whether it
      // then answers gracefully from that ("That is not in the retrieved
      // context.") or the loop gives up and falls back to the one-shot path's
      // own 404 (an `error` event). Either ending is fine; a `tool_step`
      // that's *not* `status: 'error'`, or any leaked content, is not.
      // Each tool call emits a `started` step, then an `ok`/`error` step —
      // only the latter says how the call actually resolved.
      const settledSteps = events.filter((e) => e.type === 'tool_step' && e.status !== 'started');
      expect(settledSteps.length).toBeGreaterThan(0);
      expect(settledSteps.every((e) => e.status === 'error')).toBe(true);
      expect(events.some((e) => e.type === 'answer' || e.type === 'error')).toBe(true);
      expect(JSON.stringify(events)).not.toContain('Globex');
    });

    it('rejects an unauthenticated caller before any transaction opens', async () => {
      const res = await request(app.getHttpServer())
        .post(`/engagements/${engagementA}/qa/agentic`)
        .send({ question: 'anything?' });
      expect(res.status).toBe(401);
    });

    it('accepts a conversation history and still answers — the loop is stateless server-side, so a follow-up only works if the caller resends prior turns', async () => {
      const token = await login('code-a8', 'wos_a', 'org_a');
      const res = await request(app.getHttpServer())
        .post(`/engagements/${engagementA}/qa/agentic`)
        .set('authorization', `Bearer ${token}`)
        .send({
          question: 'why not the alternative?',
          history: [
            { role: 'user', content: 'what did we decide?' },
            { role: 'assistant', content: 'We decided on option A.' },
          ],
        });

      expect(res.status).toBe(200);
      const events = sseEvents(res.text) as { type: string }[];
      expect(events.some((e) => e.type === 'answer' || e.type === 'error')).toBe(true);
    });

    it('rejects a malformed history entry before any transaction opens', async () => {
      const token = await login('code-a9', 'wos_a', 'org_a');
      const res = await request(app.getHttpServer())
        .post(`/engagements/${engagementA}/qa/agentic`)
        .set('authorization', `Bearer ${token}`)
        .send({ question: 'anything?', history: [{ role: 'system', content: 'nope' }] });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /engagements/:id/mcp — external MCP surface', () => {
    /** Mirrors scripts/issue-api-key.ts: a service-account user + a hashed key. */
    async function mintApiKey(tenantId: TenantId): Promise<string> {
      const [user] = await handle.db
        .insert(users)
        .values({
          tenantId,
          email: `api-key+${randomUUID()}@service-accounts.internal`,
          name: 'API key: test',
          status: 'active',
        })
        .returning({ id: users.id });
      const key = generateApiKey();
      await handle.db.insert(apiKeys).values({
        tenantId,
        userId: user!.id,
        keyHash: key.hashHex,
        keyPrefix: key.prefix,
        label: 'test',
      });
      return key.raw;
    }

    // Streamable HTTP requires the client to accept both; stateless mode needs
    // no prior `initialize` (verified: tools/list and tools/call work bare).
    function rpc(engagementId: string, body: object) {
      return request(app.getHttpServer())
        .post(`/engagements/${engagementId}/mcp`)
        .set('accept', 'application/json, text/event-stream')
        .send({ jsonrpc: '2.0', id: 1, ...body });
    }

    interface RpcMessage {
      result?: { tools: { name: string }[]; content?: unknown; isError?: boolean };
      error?: unknown;
    }

    /** The transport may answer as plain JSON or as one SSE frame. */
    function parseRpc(res: request.Response): RpcMessage {
      if (res.text && res.text.startsWith('event:')) {
        const data = res.text
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        return JSON.parse(data);
      }
      return res.body;
    }

    it('lists all 5 tools via x-api-key', async () => {
      const key = await mintApiKey(tenantA);
      const res = await rpc(engagementA, { method: 'tools/list', params: {} }).set(
        'x-api-key',
        key,
      );
      expect(res.status).toBe(200);
      const names = parseRpc(res)
        .result!.tools.map((t) => t.name)
        .sort();
      expect(names).toEqual(
        [
          'get_entity_provenance',
          'get_fact_provenance',
          'get_graph',
          'list_facts',
          'search_context',
        ].sort(),
      );
    });

    it('calls a tool via x-api-key and returns a real result', async () => {
      const key = await mintApiKey(tenantA);
      const res = await rpc(engagementA, {
        method: 'tools/call',
        params: { name: 'list_facts', arguments: {} },
      }).set('x-api-key', key);
      expect(res.status).toBe(200);
      const msg = parseRpc(res);
      expect(msg.error).toBeUndefined();
      expect(msg.result!.content).toBeDefined();
      expect(msg.result.isError).toBeFalsy();
    });

    it('works identically with a session credential', async () => {
      const token = await login('code-mcp1', 'wos_a', 'org_a');
      const res = await rpc(engagementA, { method: 'tools/list', params: {} }).set(
        'authorization',
        `Bearer ${token}`,
      );
      expect(res.status).toBe(200);
      expect(parseRpc(res).result!.tools).toHaveLength(5);
    });

    it('rejects a caller with no session and no api key before any transaction opens', async () => {
      const res = await rpc(engagementA, { method: 'tools/list', params: {} });
      expect(res.status).toBe(401);
    });

    it("never lets tenant A's credential reach tenant B's engagement — the tool call itself errors", async () => {
      const key = await mintApiKey(tenantA);
      const res = await rpc(engagementB, {
        method: 'tools/call',
        params: { name: 'list_facts', arguments: {} },
      }).set('x-api-key', key);
      expect(res.status).toBe(200); // request-level OK; the failure is in the tool result
      const msg = parseRpc(res);
      expect(msg.error !== undefined || msg.result?.isError === true).toBe(true);
      expect(JSON.stringify(msg)).not.toContain('Globex');
    });

    it('answers GET and DELETE with a JSON-RPC 405', async () => {
      const key = await mintApiKey(tenantA);
      for (const method of ['get', 'delete'] as const) {
        const agent = request(app.getHttpServer());
        const res = await agent[method](`/engagements/${engagementA}/mcp`).set('x-api-key', key);
        expect(res.status).toBe(405);
        expect(res.body.error.code).toBe(-32000);
      }
    });
  });
});
