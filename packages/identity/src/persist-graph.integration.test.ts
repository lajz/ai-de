import { randomUUID } from 'node:crypto';

import type {
  AclSnapshot,
  CanonicalEntity,
  CanonicalRecord,
  Connector,
  EngagementId,
  RawArtifact,
  StatusChangeFact,
  SyncEmit,
  TenantId,
} from '@fde/core';
import { getCipher, FakeKeyProvider } from '@fde/crypto';
import {
  buildConnectorSource,
  createDbClient,
  engagements,
  evidence,
  facts,
  sources,
  tenants,
  withEngagement,
  type Database,
} from '@fde/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { persistGraph, type GraphWriteContext } from './persist-graph.js';

// Needs a migrated + hardened database — see packages/db/src/rls.integration.test.ts.
const url = process.env.DATABASE_URL;

/** One `work_item`, keyed by `externalId`, whose `merged` attribute the test drives directly. */
function workItemArtifact(connector: string, externalId: string, merged: boolean): RawArtifact {
  return {
    connector,
    externalId,
    kind: 'issue',
    occurredAt: '2026-09-01T00:00:00.000Z',
    raw: { merged, title: 'Ship the thing' },
    acl: { rules: [], capturedAt: '2026-09-01T00:00:00.000Z', ttlSeconds: 3600 },
  };
}

/**
 * A connector whose `normalize` mirrors `GitHubConnector`'s shape closely
 * enough to exercise `persistGraph`'s status-change wiring, and whose
 * `detectStatusChange` fires only on the same `merged: false → true`
 * transition `GitHubConnector` does.
 */
class FakeStatusConnector implements Connector {
  readonly id = 'fake-status';
  readonly authKind = 'bearer' as const;
  readonly retentionPolicy = 'full-retention' as const;

  async *backfill(): AsyncIterable<SyncEmit> {}
  incremental(): AsyncIterable<SyncEmit> {
    return this.backfill();
  }
  async handleWebhook(): Promise<RawArtifact[]> {
    return [];
  }
  async resolveAcl(): Promise<AclSnapshot> {
    return { rules: [], capturedAt: '2026-09-01T00:00:00.000Z', ttlSeconds: 3600 };
  }
  normalize(artifact: RawArtifact): CanonicalRecord[] {
    const meta = (artifact.raw ?? {}) as { merged?: boolean; title?: string };
    return [
      {
        kind: 'entity',
        type: 'work_item',
        displayName: meta.title ?? artifact.externalId,
        externalRefs: [{ connector: 'fake-status', externalId: artifact.externalId }],
        attributes: { merged: meta.merged ?? false, title: meta.title },
      },
    ];
  }
  detectStatusChange(
    previous: Record<string, unknown>,
    next: CanonicalEntity,
  ): StatusChangeFact | null {
    if (previous.merged !== true && next.attributes.merged === true) {
      return { summary: `${next.displayName} merged`, occurredAt: '2026-09-02T00:00:00.000Z' };
    }
    return null;
  }
}

/** Same shape, minus `detectStatusChange` — a connector that never implements it (e.g. Granola). */
class NoStatusConnector implements Connector {
  readonly id = 'fake-nostatus';
  readonly authKind = 'bearer' as const;
  readonly retentionPolicy = 'full-retention' as const;

  async *backfill(): AsyncIterable<SyncEmit> {}
  incremental(): AsyncIterable<SyncEmit> {
    return this.backfill();
  }
  async handleWebhook(): Promise<RawArtifact[]> {
    return [];
  }
  async resolveAcl(): Promise<AclSnapshot> {
    return { rules: [], capturedAt: '2026-09-01T00:00:00.000Z', ttlSeconds: 3600 };
  }
  normalize(artifact: RawArtifact): CanonicalRecord[] {
    const meta = (artifact.raw ?? {}) as { merged?: boolean };
    return [
      {
        kind: 'entity',
        type: 'work_item',
        displayName: artifact.externalId,
        externalRefs: [{ connector: 'fake-nostatus', externalId: artifact.externalId }],
        attributes: { merged: meta.merged ?? false },
      },
    ];
  }
}

describe.skipIf(!url)('persistGraph — status-change facts', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

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

  /** lands a real `sources` row for `artifact` and returns its id — `persistGraph` stamps
   * evidence/relationships with it, and `evidence.source_id` has a real FK to enforce. */
  async function landSource(engagementId: EngagementId, artifact: RawArtifact): Promise<string> {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const built = await buildConnectorSource(getCipher(), {
        tenantId,
        engagementId,
        artifact,
        retentionPolicy: 'full-retention',
        aclSnapshotId: null,
      });
      const [row] = await tx.insert(sources).values(built.row).returning({ id: sources.id });
      return row!.id;
    });
  }

  async function persist(
    engagementId: EngagementId,
    connector: Connector,
    artifact: RawArtifact,
    sourceId: string,
  ) {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) => {
      const ctx: GraphWriteContext = { tenantId, engagementId, cipher: getCipher(), tx };
      return persistGraph(ctx, connector, artifact, sourceId);
    });
  }

  async function factsAndEvidence(engagementId: EngagementId) {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const factRows = await tx
        .select()
        .from(facts)
        .where(and(eq(facts.engagementId, engagementId), eq(facts.type, 'status_change')));
      const evRows = await tx
        .select()
        .from(evidence)
        .where(eq(evidence.engagementId, engagementId));
      return { factRows, evRows };
    });
  }

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('creation never synthesizes a fact, even when the entity is already "merged" on first sight', async () => {
    const engagementId = await seedEngagement();
    const externalId = `wi-${randomUUID()}`;
    // backfilling an already-merged PR — first sight, not a transition
    const artifact = workItemArtifact('fake-status', externalId, true);
    const sourceId = await landSource(engagementId, artifact);

    const tally = await persist(engagementId, new FakeStatusConnector(), artifact, sourceId);
    expect(tally.factsSynthesized).toBe(0);

    const { factRows } = await factsAndEvidence(engagementId);
    expect(factRows).toHaveLength(0);
  });

  it('an observed transition on an existing entity synthesizes exactly one fact + evidence row', async () => {
    const engagementId = await seedEngagement();
    const externalId = `wi-${randomUUID()}`;

    const created = workItemArtifact('fake-status', externalId, false);
    const createdSourceId = await landSource(engagementId, created);
    const firstTally = await persist(
      engagementId,
      new FakeStatusConnector(),
      created,
      createdSourceId,
    );
    expect(firstTally.factsSynthesized).toBe(0);

    const merged = workItemArtifact('fake-status', externalId, true);
    const mergedSourceId = await landSource(engagementId, merged);
    const secondTally = await persist(
      engagementId,
      new FakeStatusConnector(),
      merged,
      mergedSourceId,
    );
    expect(secondTally.factsSynthesized).toBe(1);

    const { factRows, evRows } = await factsAndEvidence(engagementId);
    expect(factRows).toHaveLength(1);
    expect(factRows[0]).toMatchObject({ type: 'status_change', extractionRunId: null });
    expect(evRows).toHaveLength(1);
    expect(evRows[0]).toMatchObject({
      factId: factRows[0]!.id,
      sourceId: mergedSourceId,
      extractionRunId: null,
      charStart: null,
      charEnd: null,
    });
  });

  it('an attribute change that is not a transition (e.g. a title edit) calls detectStatusChange but synthesizes nothing', async () => {
    const engagementId = await seedEngagement();
    const externalId = `wi-${randomUUID()}`;

    const created = workItemArtifact('fake-status', externalId, false);
    const createdSourceId = await landSource(engagementId, created);
    await persist(engagementId, new FakeStatusConnector(), created, createdSourceId);

    const retitled: RawArtifact = { ...created, raw: { merged: false, title: 'A new title' } };
    const retitledSourceId = await landSource(engagementId, retitled);
    const tally = await persist(
      engagementId,
      new FakeStatusConnector(),
      retitled,
      retitledSourceId,
    );
    expect(tally.factsSynthesized).toBe(0);

    const { factRows } = await factsAndEvidence(engagementId);
    expect(factRows).toHaveLength(0);
  });

  it('a connector with no detectStatusChange never crashes and never synthesizes a fact', async () => {
    const engagementId = await seedEngagement();
    const externalId = `wi-${randomUUID()}`;

    const created = workItemArtifact('fake-nostatus', externalId, false);
    const createdSourceId = await landSource(engagementId, created);
    await persist(engagementId, new NoStatusConnector(), created, createdSourceId);

    const merged = workItemArtifact('fake-nostatus', externalId, true);
    const mergedSourceId = await landSource(engagementId, merged);
    const tally = await persist(engagementId, new NoStatusConnector(), merged, mergedSourceId);
    expect(tally.factsSynthesized).toBe(0);

    const { factRows } = await factsAndEvidence(engagementId);
    expect(factRows).toHaveLength(0);
  });
});
