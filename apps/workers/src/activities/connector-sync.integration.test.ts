import { randomUUID } from 'node:crypto';

import type {
  AclSnapshot,
  CanonicalRecord,
  Connector,
  ConnectorContext,
  EngagementId,
  RawArtifact,
  SyncEmit,
  TenantId,
} from '@fde/core';
import { artifactEmit, checkpointEmit } from '@fde/core';
import { ConnectorRegistry, FakeGranolaClient, GranolaConnector } from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  aclSnapshots,
  connectorSyncState,
  createDbClient,
  engagements,
  entities,
  identityReviewQueue,
  relationships,
  sources,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { IDENTITY_REF_EMAIL } from '@fde/identity';
import { MockActivityEnvironment } from '@temporalio/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  createConnectorSyncActivities,
  type RunConnectorSyncInput,
  type RunConnectorSyncResult,
} from './connector-sync.js';

// Integration test — needs a migrated + hardened database, same convention as
// packages/db/src/engagement.test.ts:
//   docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
//   DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/workers test
const url = process.env.DATABASE_URL;

describe.skipIf(!url)('connectorSync activities (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  const registry = new ConnectorRegistry({
    granola: (ctx) =>
      new GranolaConnector({
        client: new FakeGranolaClient(),
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
  });
  const acts = () =>
    createConnectorSyncActivities({ db: handle.db, keyProvider: provider, connectors: registry });
  const run = (input: RunConnectorSyncInput): Promise<RunConnectorSyncResult> =>
    new MockActivityEnvironment().run(
      acts().runConnectorSyncActivity as never,
      input as never,
    ) as Promise<RunConnectorSyncResult>;

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

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('lands encrypted sources + acl snapshots, advances the cursor, and is dedupe-idempotent', async () => {
    const engagementId = await seedEngagement();

    const first = await run({ tenantId, engagementId, connectorId: 'granola', mode: 'backfill' });

    expect(first.artifactCount).toBe(3);
    expect(first.sourceCount).toBe(3);
    // doc-standup + doc-ext are transcripts; doc-brief is notes-only
    expect(first.transcriptSourceIds).toHaveLength(2);
    expect(first.cursor).toBe('2026-09-03T12:15:00.000Z');

    // the transcript source is ciphertext at rest and decrypts through withEngagement
    const standupId = first.transcriptSourceIds[0]!;
    const [rawRow] = await handle.db
      .select({
        rawBody: sources.rawBody,
        aclSnapshotId: sources.aclSnapshotId,
        kind: sources.kind,
      })
      .from(sources)
      .where(eq(sources.id, standupId));
    expect(rawRow!.kind).toBe('transcript');
    expect(rawRow!.aclSnapshotId).not.toBeNull();
    expect(Buffer.from(rawRow!.rawBody!).toString('utf8')).not.toContain('Friday');

    const decrypted = await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx
        .select({ rawBody: sources.rawBody })
        .from(sources)
        .where(eq(sources.id, standupId))
        .then(([r]) => getCipher().decryptString('sources.raw_body', r!.rawBody!)),
    );
    expect(decrypted).toContain('We decided to ship Orion on Friday.');

    // the acl snapshot: encrypted principal rules that decrypt to the workspace rule
    const rules = await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx
        .select({ principalRules: aclSnapshots.principalRules })
        .from(aclSnapshots)
        .where(eq(aclSnapshots.id, rawRow!.aclSnapshotId!))
        .then(([r]) =>
          getCipher().decryptJson('acl_snapshots.principal_rules', r!.principalRules!),
        ),
    );
    expect(rules).toEqual([
      {
        scope: 'granola_workspace',
        resourceId: 'ws-acme',
        principals: ['u-alice', 'u-bob'],
        public: false,
      },
    ]);

    // connector_sync_state cursor advanced + status back to idle
    const [state] = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ cursor: connectorSyncState.cursor, status: connectorSyncState.status })
        .from(connectorSyncState)
        .where(
          and(
            eq(connectorSyncState.engagementId, engagementId),
            eq(connectorSyncState.connector, 'granola'),
          ),
        ),
    );
    expect(state).toMatchObject({ cursor: '2026-09-03T12:15:00.000Z', status: 'idle' });

    // dedupe: a second backfill inserts nothing and reports no new transcripts
    const second = await run({ tenantId, engagementId, connectorId: 'granola', mode: 'backfill' });
    expect(second.sourceCount).toBe(0);
    expect(second.transcriptSourceIds).toHaveLength(0);

    const rows = await withTenant(handle.db, tenantId, (tx) =>
      tx.select({ id: sources.id }).from(sources).where(eq(sources.engagementId, engagementId)),
    );
    expect(rows).toHaveLength(3);
  });
});

/**
 * One artifact whose `normalize` returns a known mix: a `meeting`, two near-
 * duplicate `person`s (same email domain, non-identical names, no shared exact
 * ref) and two edges — one whose endpoints both exist, one pointing at an entity
 * no artifact ever creates.
 */
const GRAPH_ARTIFACT: RawArtifact = {
  connector: 'fake-graph',
  externalId: 'doc-1',
  kind: 'doc',
  occurredAt: '2026-09-03T10:00:00.000Z',
  raw: { n: 1 },
  acl: { rules: [], capturedAt: '2026-09-03T10:00:00.000Z', ttlSeconds: 3600 },
};

class FakeGraphConnector implements Connector {
  readonly id = 'fake-graph';
  readonly authKind = 'bearer' as const;
  readonly retentionPolicy = 'full-retention' as const;

  async *backfill(): AsyncIterable<SyncEmit> {
    yield artifactEmit(GRAPH_ARTIFACT);
    yield checkpointEmit('2026-09-03T10:00:00.000Z');
  }
  incremental(): AsyncIterable<SyncEmit> {
    return this.backfill();
  }
  async handleWebhook(): Promise<RawArtifact[]> {
    return [];
  }
  async resolveAcl(_ctx: ConnectorContext, _artifact: RawArtifact): Promise<AclSnapshot> {
    return { rules: [], capturedAt: '2026-09-03T10:00:00.000Z', ttlSeconds: 3600 };
  }
  normalize(_artifact: RawArtifact): CanonicalRecord[] {
    return [
      {
        kind: 'entity',
        type: 'meeting',
        displayName: 'Weekly sync',
        externalRefs: [{ connector: 'fake-graph', externalId: 'doc-1' }],
        attributes: {},
      },
      {
        kind: 'entity',
        type: 'person',
        displayName: 'Grace Hopper',
        externalRefs: [
          { connector: 'fake-graph', externalId: 'u-grace' },
          { connector: IDENTITY_REF_EMAIL, externalId: 'grace@navy.mil' },
        ],
        attributes: {},
      },
      {
        kind: 'entity',
        type: 'person',
        displayName: 'Grace Hopperr',
        externalRefs: [
          { connector: 'fake-graph', externalId: 'u-grace2' },
          { connector: IDENTITY_REF_EMAIL, externalId: 'ghopper@navy.mil' },
        ],
        attributes: {},
      },
      {
        kind: 'relationship',
        from: { connector: 'fake-graph', externalId: 'u-grace' },
        predicate: 'relates_to',
        to: { connector: 'fake-graph', externalId: 'doc-1' },
      },
      {
        kind: 'relationship',
        from: { connector: 'fake-graph', externalId: 'u-grace' },
        predicate: 'relates_to',
        to: { connector: 'fake-graph', externalId: 'ghost' },
      },
    ];
  }
}

describe.skipIf(!url)('connectorSync activities — graph persistence (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  const registry = new ConnectorRegistry({ 'fake-graph': () => new FakeGraphConnector() });
  const run = (engagementId: EngagementId): Promise<RunConnectorSyncResult> =>
    new MockActivityEnvironment().run(
      createConnectorSyncActivities({ db: handle.db, keyProvider: provider, connectors: registry })
        .runConnectorSyncActivity as never,
      { tenantId, engagementId, connectorId: 'fake-graph', mode: 'backfill' } as never,
    ) as Promise<RunConnectorSyncResult>;

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

  const graphOf = (engagementId: EngagementId) =>
    withTenant(handle.db, tenantId, async (tx) => {
      const ents = await tx
        .select({ id: entities.id, type: entities.type })
        .from(entities)
        .where(eq(entities.engagementId, engagementId));
      const rels = await tx
        .select({ predicate: relationships.predicate, sourceId: relationships.sourceId })
        .from(relationships)
        .where(eq(relationships.engagementId, engagementId));
      const queue = await tx
        .select({ id: identityReviewQueue.id })
        .from(identityReviewQueue)
        .where(eq(identityReviewQueue.tenantId, tenantId));
      return { ents, rels, queue };
    });

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  // reset the graph between tests — entities / relationships / queue rows all
  // cascade from the engagement, and `findMatchCandidates` scans per-tenant.
  afterEach(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
  });
  afterAll(async () => {
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('persists entities + relationships from normalize, queues a near-dup, defers a dangling edge', async () => {
    const engagementId = await seedEngagement();
    const first = await run(engagementId);

    expect(first.graph).toEqual({
      entitiesResolved: 2,
      entitiesUpserted: 1,
      relationshipsUpserted: 1,
      relationshipsDeferred: 1,
      matchCandidatesQueued: 1,
    });

    const g = await graphOf(engagementId);
    // two people resolved as distinct rows (near-dup queued, never merged) + one meeting
    expect(g.ents.filter((e) => e.type === 'person')).toHaveLength(2);
    expect(g.ents.filter((e) => e.type === 'meeting')).toHaveLength(1);
    expect(g.queue).toHaveLength(1);
    // the one edge whose endpoints both exist landed, stamped with the landed source
    expect(g.rels).toHaveLength(1);
    expect(g.rels[0]!.sourceId).toBe(await onlySourceId(engagementId));
  });

  it('a second sync run re-normalizes the same artifact idempotently — no dup rows', async () => {
    const engagementId = await seedEngagement();
    await run(engagementId);
    const before = await graphOf(engagementId);

    const second = await run(engagementId);
    // the source deduped, so the graph step is skipped entirely on the re-run
    expect(second.sourceCount).toBe(0);
    expect(second.graph).toEqual({
      entitiesResolved: 0,
      entitiesUpserted: 0,
      relationshipsUpserted: 0,
      relationshipsDeferred: 0,
      matchCandidatesQueued: 0,
    });

    const after = await graphOf(engagementId);
    expect(after.ents).toHaveLength(before.ents.length);
    expect(after.rels).toHaveLength(before.rels.length);
    expect(after.queue).toHaveLength(before.queue.length);
  });

  async function onlySourceId(engagementId: EngagementId): Promise<string> {
    const [row] = await withTenant(handle.db, tenantId, (tx) =>
      tx.select({ id: sources.id }).from(sources).where(eq(sources.engagementId, engagementId)),
    );
    return row!.id;
  }
});
