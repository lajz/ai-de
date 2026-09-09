import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { ConnectorRegistry, FakeGranolaClient, GranolaConnector } from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  aclSnapshots,
  connectorSyncState,
  createDbClient,
  engagements,
  sources,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { MockActivityEnvironment } from '@temporalio/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
