import { createHmac, randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeLinearClient, LinearConnector } from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  engagements,
  selectConnectorConfigByScopeRef,
  sources,
  tenants,
  upsertConnectorConfig,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WebhookLandingService } from './webhook-landing.service.js';

// Integration test — needs a migrated + hardened database, same convention as
// packages/db/src/engagement.test.ts:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/api test
const url = process.env.DATABASE_URL;

const WEBHOOK_SECRET = 'whsec_test';
const sign = (raw: Buffer) => createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');

function issueWebhookPayload(id: string, organizationId = 'org-acme'): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'update',
      type: 'Issue',
      organizationId,
      data: {
        id,
        identifier: 'ENG-9',
        title: 'From a webhook',
        description: null,
        url: `https://linear.app/acme/issue/ENG-9`,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T01:00:00.000Z',
        state: { name: 'Done' },
      },
    }),
  );
}

describe.skipIf(!url)('WebhookLandingService (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  let service: WebhookLandingService;
  const tenantId = randomUUID() as TenantId;

  const connector = () =>
    new LinearConnector({
      clientFactory: () => new FakeLinearClient(),
      engagementRetentionPolicy: 'full-retention',
      webhookSecret: WEBHOOK_SECRET,
    });

  async function seedEngagement(): Promise<EngagementId> {
    const engagementId = randomUUID() as EngagementId;
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    await handle.db.insert(engagements).values({
      id: engagementId,
      tenantId,
      endCustomerName: `Acme ${engagementId.slice(0, 8)}`,
      regionPin: 'us',
      retentionPolicy: 'full-retention',
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
    return engagementId;
  }

  /** claims `externalScopeRef` for `engagementId`, with a Nango connection id stored as `credentialRef`. */
  async function claimScope(engagementId: EngagementId, externalScopeRef: string): Promise<void> {
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const credentialRef = await getCipher().encryptString(
        'connector_config.credential_ref',
        'nango-conn-linear-1',
      );
      await upsertConnectorConfig(
        tx,
        { tenantId, engagementId, connector: 'linear' },
        { enabled: true, credentialRef, externalScopeRef },
      );
    });
  }

  const sourceRows = (engagementId: EngagementId) =>
    withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ id: sources.id, externalId: sources.externalId })
        .from(sources)
        .where(and(eq(sources.engagementId, engagementId), eq(sources.connector, 'linear'))),
    );

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
    service = new WebhookLandingService(handle.db, provider);
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('a verified webhook, matching a claimed scope, lands a new sources row', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const raw = issueWebhookPayload('iss-hook-1', scopeRef);
    const artifacts = await connector().handleWebhook({
      headers: { 'linear-signature': sign(raw) },
      rawBody: raw,
      connectorId: 'linear',
    });
    expect(artifacts).toHaveLength(1);

    const result = await service.landWebhookArtifacts({
      connectorId: 'linear',
      connector: connector(),
      externalScopeRef: scopeRef,
      artifacts,
    });
    expect(result).toEqual({ matched: true, landed: 1 });

    const rows = await sourceRows(engagementId);
    expect(rows).toEqual([{ id: expect.any(String), externalId: 'iss-hook-1' }]);
  });

  it('redelivering the same payload does not create a duplicate sources row', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const raw = issueWebhookPayload('iss-hook-2', scopeRef);
    const land = async () => {
      const artifacts = await connector().handleWebhook({
        headers: { 'linear-signature': sign(raw) },
        rawBody: raw,
        connectorId: 'linear',
      });
      return service.landWebhookArtifacts({
        connectorId: 'linear',
        connector: connector(),
        externalScopeRef: scopeRef,
        artifacts,
      });
    };

    const first = await land();
    expect(first).toEqual({ matched: true, landed: 1 });
    const second = await land();
    expect(second).toEqual({ matched: true, landed: 0 });

    expect(await sourceRows(engagementId)).toHaveLength(1);
  });

  it('no connector_config claims the scope → discarded cleanly, nothing lands', async () => {
    const scopeRef = `org-unclaimed-${randomUUID()}`;
    const raw = issueWebhookPayload('iss-hook-3', scopeRef);
    const artifacts = await connector().handleWebhook({
      headers: { 'linear-signature': sign(raw) },
      rawBody: raw,
      connectorId: 'linear',
    });

    const result = await service.landWebhookArtifacts({
      connectorId: 'linear',
      connector: connector(),
      externalScopeRef: scopeRef,
      artifacts,
    });
    expect(result).toEqual({ matched: false, landed: 0 });
    expect(await selectConnectorConfigByScopeRef(handle.db, 'linear', scopeRef)).toBeUndefined();
  });

  it('an invalid signature never reaches landing — handleWebhook itself throws', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const raw = issueWebhookPayload('iss-hook-4', scopeRef);
    await expect(
      connector().handleWebhook({
        headers: { 'linear-signature': 'deadbeef' },
        rawBody: raw,
        connectorId: 'linear',
      }),
    ).rejects.toThrow(/signature/);

    expect(await sourceRows(engagementId)).toHaveLength(0);
  });
});
