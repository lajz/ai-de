import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database } from './client.js';
import { selectConnectorConfigs, upsertConnectorConfig } from './connector-config.js';
import {
  selectEntityForProvenance,
  selectEntityProvenanceEdges,
  selectExtractionRun,
  selectFactForProvenance,
  selectFactsByIds,
  selectGraphEdges,
  selectGraphEntities,
  selectPipelineRollups,
  selectProvenanceEvidence,
} from './lineage.js';
import { withEngagement } from './engagement.js';
import { withTenant } from './rls.js';
import {
  aclSnapshots,
  entities,
  evidence,
  extractionRuns,
  facts,
  relationships,
  sources,
  tenants,
  engagements,
} from './schema/index.js';

// Integration test — needs a migrated + hardened database, same convention as
// `engagement.test.ts` / `connector-sync.integration.test.ts`:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/db test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('lineage + connector_config (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantA = randomUUID() as TenantId;
  const tenantB = randomUUID() as TenantId;

  async function seedEngagement(tenantId: TenantId): Promise<EngagementId> {
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

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'A', cmkKeyRef: 'fake:cmk' },
      { id: tenantB, name: 'B', cmkKeyRef: 'fake:cmk' },
    ]);
  });
  afterAll(async () => {
    for (const t of [tenantA, tenantB]) {
      await handle.db.delete(engagements).where(eq(engagements.tenantId, t));
      await handle.db.delete(tenants).where(eq(tenants.id, t));
    }
    await handle.close();
  });

  it('round-trips an encrypted credential through withEngagement', async () => {
    const engagementId = await seedEngagement(tenantA);

    await withEngagement(handle.db, provider, { tenantId: tenantA, engagementId }, async (tx) => {
      const credentialRef = await getCipher().encryptString(
        'connector_config.credential_ref',
        'grn_live_secret',
      );
      await upsertConnectorConfig(
        tx,
        { tenantId: tenantA, engagementId, connector: 'granola' },
        { enabled: true, credentialRef },
      );
    });

    const decrypted = await withEngagement(
      handle.db,
      provider,
      { tenantId: tenantA, engagementId },
      async (tx) => {
        const [row] = await selectConnectorConfigs(tx, tenantA, engagementId);
        expect(row!.enabled).toBe(true);
        expect(row!.credentialRef).toBeInstanceOf(Uint8Array);
        return getCipher().decryptString('connector_config.credential_ref', row!.credentialRef!);
      },
    );
    expect(decrypted).toBe('grn_live_secret');
  });

  it('assembles a provenance chain from seeded rows', async () => {
    const engagementId = await seedEngagement(tenantA);
    const factId = randomUUID();

    await withEngagement(handle.db, provider, { tenantId: tenantA, engagementId }, async (tx) => {
      const [run] = await tx
        .insert(extractionRuns)
        .values({
          tenantId: tenantA,
          engagementId,
          model: 'claude-opus-5',
          promptVersion: 'v3',
          inputSourceIds: [],
          costUsd: 0.03,
        })
        .returning({ id: extractionRuns.id });

      const [acl] = await tx
        .insert(aclSnapshots)
        .values({
          tenantId: tenantA,
          engagementId,
          sourceRef: 'granola:ext-1',
          principalRules: await getCipher().encryptJson('acl_snapshots.principal_rules', [
            { scope: 'granola_workspace', resourceId: 'ws-1', principals: ['u1'], public: false },
          ]),
          capturedAt: new Date('2026-01-01T00:00:00Z'),
          ttlSeconds: 3600,
        })
        .returning({ id: aclSnapshots.id });

      const [src] = await tx
        .insert(sources)
        .values({
          tenantId: tenantA,
          engagementId,
          connector: 'granola',
          externalId: 'ext-1',
          kind: 'transcript',
          urlPermalink: 'https://ex.com/p/1',
          workspaceRef: 'ws-1',
          containerRef: 'meeting-42',
          authorRef: 'jane@example.com',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          contentHash: 'hash-1',
          retentionPolicy: 'full-retention',
          aclSnapshotId: acl!.id,
        })
        .returning({ id: sources.id });

      await tx.insert(facts).values({
        id: factId,
        tenantId: tenantA,
        engagementId,
        type: 'decision',
        summary: 'chose Postgres',
        body: await getCipher().encryptString('facts.body', 'full rationale here'),
        extractionRunId: run!.id,
      });

      await tx.insert(evidence).values({
        tenantId: tenantA,
        engagementId,
        factId,
        sourceId: src!.id,
        quote: await getCipher().encryptString('evidence.quote', 'we will use postgres'),
        charStart: 0,
        charEnd: 20,
        relation: 'supports',
      });
    });

    await withEngagement(handle.db, provider, { tenantId: tenantA, engagementId }, async (tx) => {
      const fact = await selectFactForProvenance(tx, tenantA, engagementId, factId);
      expect(fact).toBeDefined();
      expect(await getCipher().decryptString('facts.body', fact!.body!)).toBe(
        'full rationale here',
      );

      const ev = await selectProvenanceEvidence(tx, tenantA, engagementId, factId);
      expect(ev).toHaveLength(1);
      expect(await getCipher().decryptString('evidence.quote', ev[0]!.quote!)).toBe(
        'we will use postgres',
      );
      expect(ev[0]!.connector).toBe('granola');
      expect(ev[0]!.workspaceRef).toBe('ws-1');
      expect(ev[0]!.containerRef).toBe('meeting-42');
      expect(ev[0]!.authorRef).toBe('jane@example.com');
      const rules = await getCipher().decryptJson(
        'acl_snapshots.principal_rules',
        ev[0]!.aclPrincipalRules!,
      );
      expect(rules).toHaveLength(1);

      const run = await selectExtractionRun(tx, tenantA, engagementId, fact!.extractionRunId!);
      expect(run!.model).toBe('claude-opus-5');

      const rollups = await selectPipelineRollups(tx, tenantA, engagementId);
      expect(rollups.totalFacts).toBe(1);
      expect(rollups.sourcesByConnector).toEqual({ granola: 1 });
      expect(rollups.totalCostUsd).toBeCloseTo(0.03);
    });
  });

  it('reads the entity graph as cleartext', async () => {
    const engagementId = await seedEngagement(tenantA);
    const [a, b] = [randomUUID(), randomUUID()];

    await withEngagement(handle.db, provider, { tenantId: tenantA, engagementId }, async (tx) => {
      await tx.insert(entities).values([
        {
          id: a,
          tenantId: tenantA,
          engagementId,
          type: 'person',
          displayName: 'Jane',
          attributes: await getCipher().encryptJson('entities.attributes', {}),
        },
        {
          id: b,
          tenantId: tenantA,
          engagementId,
          type: 'organization',
          displayName: 'Acme',
          attributes: await getCipher().encryptJson('entities.attributes', {}),
        },
      ]);
      await tx.insert(relationships).values({
        tenantId: tenantA,
        engagementId,
        fromKind: 'entity',
        fromId: a,
        predicate: 'member_of',
        toKind: 'entity',
        toId: b,
      });
    });

    await withTenant(handle.db, tenantA, async (tx) => {
      const nodes = await selectGraphEntities(tx, tenantA, engagementId, {});
      expect(nodes.map((n) => n.displayName).sort()).toEqual(['Acme', 'Jane']);
      const people = await selectGraphEntities(tx, tenantA, engagementId, { entityType: 'person' });
      expect(people).toHaveLength(1);
      const edges = await selectGraphEdges(tx, tenantA, engagementId, { limit: 10 });
      expect(edges[0]!.predicate).toBe('member_of');
    });
  });

  it('walks entity-touching relationships (either direction) to their attesting sources', async () => {
    const engagementId = await seedEngagement(tenantA);
    const [person, factId] = [randomUUID(), randomUUID()];

    await withEngagement(handle.db, provider, { tenantId: tenantA, engagementId }, async (tx) => {
      await tx.insert(entities).values({
        id: person,
        tenantId: tenantA,
        engagementId,
        type: 'person',
        displayName: 'Jane',
        attributes: await getCipher().encryptJson('entities.attributes', {}),
      });
      await tx.insert(facts).values({
        id: factId,
        tenantId: tenantA,
        engagementId,
        type: 'decision',
        summary: 'chose Postgres',
      });
      const [src] = await tx
        .insert(sources)
        .values({
          tenantId: tenantA,
          engagementId,
          connector: 'linear',
          externalId: 'ext-comment-1',
          kind: 'comment',
          containerRef: 'issue-42',
          authorRef: 'jane@example.com',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          contentHash: 'hash-2',
          retentionPolicy: 'full-retention',
        })
        .returning({ id: sources.id });
      await tx.insert(relationships).values({
        tenantId: tenantA,
        engagementId,
        fromKind: 'entity',
        fromId: person,
        predicate: 'owns',
        toKind: 'fact',
        toId: factId,
        sourceId: src!.id,
      });
    });

    await withTenant(handle.db, tenantA, async (tx) => {
      const entity = await selectEntityForProvenance(tx, tenantA, engagementId, person);
      expect(entity).toEqual({ id: person, type: 'person', displayName: 'Jane' });

      const edges = await selectEntityProvenanceEdges(tx, tenantA, engagementId, person);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        predicate: 'owns',
        fromKind: 'entity',
        fromId: person,
        toKind: 'fact',
        toId: factId,
        connector: 'linear',
        containerRef: 'issue-42',
        authorRef: 'jane@example.com',
      });

      const facts_ = await selectFactsByIds(tx, tenantA, engagementId, [factId]);
      expect(facts_).toEqual([{ id: factId, type: 'decision', summary: 'chose Postgres' }]);
    });
  });

  it('does not leak tenant A config to tenant B (RLS)', async () => {
    const engagementA = await seedEngagement(tenantA);
    await withEngagement(
      handle.db,
      provider,
      { tenantId: tenantA, engagementId: engagementA },
      (tx) =>
        upsertConnectorConfig(
          tx,
          { tenantId: tenantA, engagementId: engagementA, connector: 'granola' },
          { enabled: true },
        ),
    );

    const asB = await withTenant(handle.db, tenantB, (tx) =>
      selectConnectorConfigs(tx, tenantA, engagementA),
    );
    expect(asB).toEqual([]);
  });
});
