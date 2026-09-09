import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { AuthzClient, InMemoryAuthzClient } from '@fde/authz';
import { encryptRow, FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  CRYPTO_COLUMNS,
  embeddings,
  engagements,
  evidence,
  extractionRuns,
  facts,
  sources,
  tenants,
  users,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { FakeEmbeddingClient } from '@fde/llm';
import { eq } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { FakeWorkOsService } from '../auth/fake-workos.service.js';

// DB-backed — same convention as seam.integration.test.ts. Skipped unless
// DATABASE_URL is set (migrated + hardened db).
const url = process.env.DATABASE_URL;

const tenantId = randomUUID() as TenantId;
const engagementId = randomUUID() as EngagementId;
const sourceId = randomUUID();
const runId = randomUUID();
const CHUNK = 'Alice: we will standardize on Postgres for the system of record.';
const QUOTE = 'we will standardize on Postgres';
const FACT_BODY = 'Postgres chosen over DynamoDB for relational querying and pgvector.';

process.env.WORKOS_ORG_TENANT_MAP = JSON.stringify({ org_r: tenantId });

const provider = new FakeKeyProvider();
const fakeEmbeddings = new FakeEmbeddingClient();
const fakeRouter = {
  complete: async () => ({
    text: `They standardized on Postgres (https://ex.com/transcript/1).`,
    usage: {},
  }),
};

async function seedEngagement(db: Database, id: EngagementId, name: string) {
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

describe.skipIf(!url)('apps/api retrieval read path (integration)', () => {
  let handle: { db: Database; close: () => Promise<void> };
  let app: INestApplication;
  let closeApp: () => Promise<void>;
  let workos: FakeWorkOsService;
  let userId: string;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'Tenant R', cmkKeyRef: 'fake:r' });
    await seedEngagement(handle.db, engagementId, 'Acme');

    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const cipher = getCipher();
      await tx.insert(sources).values({
        id: sourceId,
        tenantId,
        engagementId,
        connector: 'recall',
        externalId: 'ext-1',
        kind: 'transcript',
        urlPermalink: 'https://ex.com/transcript/1',
        occurredAt: new Date('2026-02-01T00:00:00Z'),
        contentHash: 'hash-1',
        retentionPolicy: 'full-retention',
      });
      await tx.insert(extractionRuns).values({
        id: runId,
        tenantId,
        engagementId,
        model: 'claude-sonnet-5',
        promptVersion: '2026-02-14',
        inputSourceIds: [sourceId],
      });
      const factRow = await encryptRow(cipher, CRYPTO_COLUMNS.facts, { body: FACT_BODY });
      const [f] = await tx
        .insert(facts)
        .values({
          tenantId,
          engagementId,
          type: 'decision',
          summary: 'The team will standardize on Postgres.',
          body: factRow.body,
          confidence: 0.9,
          extractionRunId: runId,
        })
        .returning({ id: facts.id });
      const evRow = await encryptRow(cipher, CRYPTO_COLUMNS.evidence, { quote: QUOTE });
      await tx.insert(evidence).values({
        tenantId,
        engagementId,
        factId: f!.id,
        sourceId,
        quote: evRow.quote,
        charStart: CHUNK.indexOf(QUOTE),
        charEnd: CHUNK.indexOf(QUOTE) + QUOTE.length,
        relation: 'supports',
        extractionRunId: runId,
      });
      const [vector] = await fakeEmbeddings.embed([CHUNK]);
      await tx.insert(embeddings).values({
        tenantId,
        engagementId,
        sourceId,
        chunkRef: 'hash-1:0',
        model: fakeEmbeddings.model,
        embedding: vector!,
      });
    });

    const { createTestApp } = await import('../test/harness.js');
    ({
      app,
      workos,
      close: closeApp,
    } = await createTestApp({
      db: handle.db,
      authz: new InMemoryAuthzClient(),
      router: fakeRouter,
      embeddingClient: fakeEmbeddings,
      enforceAuthz: true,
    }));

    const token = await login('code-r', 'wos_r', 'org_r');
    userId = (await request(app.getHttpServer()).get('/me').set('authorization', `Bearer ${token}`))
      .body.userId as string;
  });

  afterAll(async () => {
    await closeApp?.();
    if (handle) {
      await withTenant(handle.db, tenantId, (tx) =>
        tx.delete(engagements).where(eq(engagements.id, engagementId)),
      );
      await withTenant(handle.db, tenantId, (tx) =>
        tx.delete(users).where(eq(users.tenantId, tenantId)),
      );
      await handle.close();
    }
  });

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
    return (res.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('fde_session='))!
      .slice('fde_session='.length)
      .split(';')[0]!;
  }

  async function auth() {
    const token = await login(`c-${randomUUID()}`, 'wos_r', 'org_r');
    return (r: request.Test) => r.set('authorization', `Bearer ${token}`);
  }

  it('GET :id/facts → 403 under enforce without a role', async () => {
    const as = await auth();
    const res = await as(request(app.getHttpServer()).get(`/engagements/${engagementId}/facts`));
    expect(res.status).toBe(403);
  });

  it('GET :id/facts → 200, decrypts body + quote, citations carry permalinks', async () => {
    const authz = app.get(AuthzClient, { strict: false }) as InMemoryAuthzClient;
    await authz.grantEngagementRole(userId, engagementId, 'viewer');
    const as = await auth();
    const res = await as(request(app.getHttpServer()).get(`/engagements/${engagementId}/facts`));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].body).toBe(FACT_BODY);
    expect(res.body[0].citations[0]).toMatchObject({
      permalink: 'https://ex.com/transcript/1',
      quote: QUOTE,
      relation: 'supports',
    });
  });

  it('POST :id/qa → answer + citations against the seeded facts/embeddings', async () => {
    const authz = app.get(AuthzClient, { strict: false }) as InMemoryAuthzClient;
    await authz.grantEngagementRole(userId, engagementId, 'viewer');
    const as = await auth();
    const res = await as(
      request(app.getHttpServer())
        .post(`/engagements/${engagementId}/qa`)
        .send({ question: 'Which database did they pick?' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.answer).toContain('Postgres');
    expect(res.body.citations[0]).toMatchObject({
      permalink: 'https://ex.com/transcript/1',
      quote: QUOTE,
    });
  });
});
