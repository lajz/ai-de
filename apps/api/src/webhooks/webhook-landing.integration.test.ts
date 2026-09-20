import { createHmac, randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeLinearClient, LinearConnector } from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  engagements,
  entities,
  facts,
  relationships,
  selectConnectorConfigByScopeRef,
  sources,
  tenants,
  upsertConnectorConfig,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { ZERO_TALLY } from '@fde/identity';
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

interface IssueWebhookOverrides {
  description?: string | null;
  assignee?: { id: string; name?: string; email?: string };
  creator?: { id: string; name?: string; email?: string };
}

function issueWebhookPayload(
  id: string,
  organizationId = 'org-acme',
  overrides: IssueWebhookOverrides = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'update',
      type: 'Issue',
      organizationId,
      data: {
        id,
        identifier: 'ENG-9',
        title: 'From a webhook',
        description: overrides.description ?? null,
        url: `https://linear.app/acme/issue/ENG-9`,
        createdAt: '2026-09-05T00:00:00.000Z',
        updatedAt: '2026-09-05T01:00:00.000Z',
        state: { name: 'Done' },
        ...(overrides.assignee ? { assignee: overrides.assignee } : {}),
        ...(overrides.creator ? { creator: overrides.creator } : {}),
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

  const graphOf = (engagementId: EngagementId) =>
    withTenant(handle.db, tenantId, async (tx) => {
      const ents = await tx
        .select({ id: entities.id, type: entities.type, displayName: entities.displayName })
        .from(entities)
        .where(eq(entities.engagementId, engagementId));
      const rels = await tx
        .select({
          predicate: relationships.predicate,
          sourceId: relationships.sourceId,
          fromKind: relationships.fromKind,
          fromId: relationships.fromId,
          toKind: relationships.toKind,
          toId: relationships.toId,
        })
        .from(relationships)
        .where(eq(relationships.engagementId, engagementId));
      return { ents, rels };
    });

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
    expect(result).toEqual({
      matched: true,
      landed: 1,
      graph: { ...ZERO_TALLY, entitiesUpserted: 1 },
    });

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
    expect(first).toEqual({
      matched: true,
      landed: 1,
      graph: { ...ZERO_TALLY, entitiesUpserted: 1 },
    });
    const second = await land();
    expect(second).toEqual({ matched: true, landed: 0, graph: ZERO_TALLY });

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
    expect(result).toEqual({ matched: false, landed: 0, graph: ZERO_TALLY });
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

  it('lands the work_item entity plus owns/informed_of edges, and defers the decision-marker edge', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const raw = issueWebhookPayload('iss-hook-graph-1', scopeRef, {
      // no `fde` decision fact with this id exists in the graph — the edge is
      // deferred, not an error, same as `persistGraph`'s own contract.
      description: 'Ships the plan.\n\nfde:decision:dec-unseen',
      assignee: { id: 'lin-alice', name: 'Alice', email: 'alice@acme.test' },
      creator: { id: 'lin-bob', name: 'Bob', email: 'bob@acme.test' },
    });
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
    expect(result).toEqual({
      matched: true,
      landed: 1,
      graph: {
        entitiesResolved: 2, // assignee + creator, resolved as `person` via @fde/identity
        entitiesUpserted: 1, // the work_item
        relationshipsUpserted: 2, // owns (assignee) + informed_of (creator)
        relationshipsDeferred: 1, // the decision-marker edge — no `dec-unseen` fact yet
        matchCandidatesQueued: 0,
        factsSynthesized: 0, // LinearConnector doesn't implement detectStatusChange
      },
    });

    const g = await graphOf(engagementId);
    expect(g.ents.filter((e) => e.type === 'work_item')).toHaveLength(1);
    expect(g.ents.filter((e) => e.type === 'person')).toHaveLength(2);
    expect(g.rels.map((r) => r.predicate).sort()).toEqual(['informed_of', 'owns']);
    const sourceId = (await sourceRows(engagementId))[0]!.id;
    expect(g.rels.every((r) => r.sourceId === sourceId)).toBe(true);
  });

  it('resolves the decision-marker edge against a fact that already exists', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const factId = randomUUID();
    await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx.insert(facts).values({
        id: factId,
        tenantId,
        engagementId,
        type: 'decision',
        summary: 'chose Postgres',
      }),
    );

    const raw = issueWebhookPayload('iss-hook-graph-3', scopeRef, {
      description: `Ships the plan.\n\nfde:decision:${factId}`,
    });
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
    expect(result.graph.relationshipsDeferred).toBe(0);
    expect(result.graph.relationshipsUpserted).toBe(1);

    const g = await graphOf(engagementId);
    const workItem = g.ents.find((e) => e.type === 'work_item')!;
    expect(g.rels).toEqual([
      expect.objectContaining({
        predicate: 'implemented_by',
        fromKind: 'fact',
        fromId: factId,
        toKind: 'entity',
        toId: workItem.id,
      }),
    ]);
  });

  it('redelivering the same payload does not create duplicate relationship edges', async () => {
    const engagementId = await seedEngagement();
    const scopeRef = `org-${randomUUID()}`;
    await claimScope(engagementId, scopeRef);

    const raw = issueWebhookPayload('iss-hook-graph-2', scopeRef, {
      assignee: { id: 'lin-carol', name: 'Carol', email: 'carol@acme.test' },
    });
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

    await land();
    const before = await graphOf(engagementId);
    expect(before.rels).toHaveLength(1);

    const second = await land();
    // the source deduped, so the graph step is skipped entirely on redelivery
    expect(second.graph).toEqual(ZERO_TALLY);

    const after = await graphOf(engagementId);
    expect(after.ents).toHaveLength(before.ents.length);
    expect(after.rels).toHaveLength(before.rels.length);
  });
});
