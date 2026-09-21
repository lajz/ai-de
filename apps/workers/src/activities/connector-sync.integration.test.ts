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
import {
  ConnectorRegistry,
  FakeGitHubClient,
  FakeGranolaClient,
  FakeLinearClient,
  FakeNangoClient,
  GitHubConnector,
  GranolaConnector,
  LinearConnector,
  type GitHubClient,
  type GitHubPage,
  type GitHubPullRequest,
  type GitHubRepository,
  type ListPullRequestsOptions,
} from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  aclSnapshots,
  connectorSyncState,
  createDbClient,
  engagements,
  entities,
  facts,
  identityReviewQueue,
  relationships,
  sources,
  tenants,
  upsertConnectorConfig,
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

  // `metadata.repo` is how `GitHubConnector` learns its bound repo (see its
  // header comment) — the same Nango connection-metadata channel `workspace`
  // already exercises for Linear; both live on this one fake connection.
  const nango = new FakeNangoClient({
    accessToken: 'tok-linear-123',
    metadata: { workspace: 'ws-fake', repo: 'acme/orion' },
  });
  const registry = new ConnectorRegistry({
    granola: (ctx) =>
      new GranolaConnector({
        client: new FakeGranolaClient(),
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
    linear: (ctx) =>
      new LinearConnector({
        clientFactory: () => new FakeLinearClient(),
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
    github: (ctx) =>
      new GitHubConnector({
        clientFactory: () => new FakeGitHubClient(),
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
  });
  const acts = () =>
    createConnectorSyncActivities({
      db: handle.db,
      keyProvider: provider,
      connectors: registry,
      nango,
    });
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

  it('nango-oauth getCredential: decrypts the connection id, calls Nango, ingests with the token', async () => {
    const engagementId = await seedEngagement();

    // store the Nango connection id, encrypted with the engagement DEK — the
    // shape `PUT /admin/.../connectors/linear` writes
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const credentialRef = await getCipher().encryptString(
        'connector_config.credential_ref',
        'nango-conn-linear-1',
      );
      await upsertConnectorConfig(
        tx,
        { tenantId, engagementId, connector: 'linear' },
        { enabled: true, credentialRef },
      );
    });

    const before = nango.calls.length;
    const res = await run({ tenantId, engagementId, connectorId: 'linear', mode: 'backfill' });

    // Nango was asked for a fresh token with the decrypted connection id + the
    // connector id as the providerConfigKey
    expect(nango.calls.slice(before)).toContainEqual(['nango-conn-linear-1', 'linear']);
    expect(res.sourceCount).toBe(3);

    const issueRows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ kind: sources.kind, connector: sources.connector })
        .from(sources)
        .where(and(eq(sources.engagementId, engagementId), eq(sources.connector, 'linear'))),
    );
    expect(issueRows).toHaveLength(3);
    expect(issueRows.every((r) => r.kind === 'issue')).toBe(true);
  });

  it('nango-oauth getCredential: a missing connection id fails (retryable)', async () => {
    const engagementId = await seedEngagement();
    await expect(
      run({ tenantId, engagementId, connectorId: 'linear', mode: 'backfill' }),
    ).rejects.toThrow(/no Nango connection id/);
  });

  it('github (nango-oauth, repo scope via metadata.repo): decrypts the connection id, calls Nango, ingests PRs with the token', async () => {
    const engagementId = await seedEngagement();

    // same shape as the Linear case above — `PUT /admin/.../connectors/github`
    // additionally writes `externalScopeRef` (`owner/repo`), which the webhook
    // path looks up by; the backfill/incremental path here never reads it —
    // `GitHubConnector` instead learns the repo from the Nango connection's
    // own `metadata.repo` (see its header comment for why).
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const credentialRef = await getCipher().encryptString(
        'connector_config.credential_ref',
        'nango-conn-github-1',
      );
      await upsertConnectorConfig(
        tx,
        { tenantId, engagementId, connector: 'github' },
        { enabled: true, credentialRef, externalScopeRef: 'acme/orion' },
      );
    });

    const before = nango.calls.length;
    const res = await run({ tenantId, engagementId, connectorId: 'github', mode: 'backfill' });

    expect(nango.calls.slice(before)).toContainEqual(['nango-conn-github-1', 'github']);
    expect(res.sourceCount).toBe(3);

    const prRows = await withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ kind: sources.kind, connector: sources.connector })
        .from(sources)
        .where(and(eq(sources.engagementId, engagementId), eq(sources.connector, 'github'))),
    );
    expect(prRows).toHaveLength(3);
    expect(prRows.every((r) => r.kind === 'issue')).toBe(true);
  });
});

/** A `GitHubClient` whose backing PR list can be swapped between calls — lets a test drive
 * `backfill` against one snapshot and a later `incremental` against another, so a PR's
 * `merged` flag can flip between the two runs (`FakeGitHubClient` itself is immutable). */
class SwappableGitHubClient implements GitHubClient {
  current: FakeGitHubClient;
  constructor(initial: FakeGitHubClient) {
    this.current = initial;
  }
  listRepository(): Promise<GitHubRepository> {
    return this.current.listRepository();
  }
  listPullRequests(options?: ListPullRequestsOptions): Promise<GitHubPage<GitHubPullRequest>> {
    return this.current.listPullRequests(options);
  }
}

const STATUS_PR_BASE: GitHubPullRequest = {
  id: 'pr-status-1',
  number: 501,
  title: 'Feature work',
  body: null,
  state: 'open',
  merged: false,
  url: 'https://github.com/acme/status-repo/pull/501',
  baseRef: 'main',
  headRef: 'feature',
  createdAt: '2026-09-10T00:00:00.000Z',
  updatedAt: '2026-09-10T00:00:00.000Z',
  author: { id: 'gh-alice', login: 'alice', name: null, email: null },
  requestedReviewers: [],
  completedReviewers: [],
};

describe.skipIf(!url)('connectorSync activities — GitHub status-change facts (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;
  // `metadata.repo` is how `GitHubConnector` learns its bound repo — see its
  // header comment (`connector_config.externalScopeRef` is only how a webhook
  // resolves a scope; backfill/incremental never read it).
  const nango = new FakeNangoClient({
    accessToken: 'tok-github-status',
    metadata: { repo: 'acme/status-repo' },
  });

  const client = new SwappableGitHubClient(
    new FakeGitHubClient({
      repository: {
        id: 'repo-status',
        fullName: 'acme/status-repo',
        private: false,
        collaboratorIds: [],
      },
      pullRequests: [STATUS_PR_BASE],
    }),
  );
  const registry = new ConnectorRegistry({
    github: (ctx) =>
      new GitHubConnector({
        clientFactory: () => client,
        engagementRetentionPolicy: ctx.engagementRetentionPolicy,
      }),
  });
  const acts = () =>
    createConnectorSyncActivities({
      db: handle.db,
      keyProvider: provider,
      connectors: registry,
      nango,
    });
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
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const credentialRef = await getCipher().encryptString(
        'connector_config.credential_ref',
        `nango-conn-github-status-${engagementId}`,
      );
      await upsertConnectorConfig(
        tx,
        { tenantId, engagementId, connector: 'github' },
        // scoped per engagement — `externalScopeRef` is a unique claim per
        // connector, and each test here seeds its own engagement.
        { enabled: true, credentialRef, externalScopeRef: `acme/status-repo-${engagementId}` },
      );
    });
    return engagementId;
  }

  const statusChangeFacts = (engagementId: EngagementId) =>
    withTenant(handle.db, tenantId, (tx) =>
      tx
        .select({ id: facts.id, summary: facts.summary, extractionRunId: facts.extractionRunId })
        .from(facts)
        .where(and(eq(facts.engagementId, engagementId), eq(facts.type, 'status_change'))),
    );

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('backfilling an already-merged PR is a creation, not a transition — no fact', async () => {
    const engagementId = await seedEngagement();
    client.current = new FakeGitHubClient({
      repository: {
        id: 'repo-status',
        fullName: 'acme/status-repo',
        private: false,
        collaboratorIds: [],
      },
      pullRequests: [{ ...STATUS_PR_BASE, state: 'closed', merged: true }],
    });

    const result = await run({ tenantId, engagementId, connectorId: 'github', mode: 'backfill' });
    expect(result.graph.factsSynthesized).toBe(0);
    expect(await statusChangeFacts(engagementId)).toHaveLength(0);
  });

  it('incremental observing the same PR flip merged false → true produces exactly one fact', async () => {
    const engagementId = await seedEngagement();
    client.current = new FakeGitHubClient({
      repository: {
        id: 'repo-status',
        fullName: 'acme/status-repo',
        private: false,
        collaboratorIds: [],
      },
      pullRequests: [STATUS_PR_BASE],
    });

    const backfill = await run({ tenantId, engagementId, connectorId: 'github', mode: 'backfill' });
    expect(backfill.graph.factsSynthesized).toBe(0);
    expect(await statusChangeFacts(engagementId)).toHaveLength(0);

    client.current = new FakeGitHubClient({
      repository: {
        id: 'repo-status',
        fullName: 'acme/status-repo',
        private: false,
        collaboratorIds: [],
      },
      pullRequests: [
        { ...STATUS_PR_BASE, state: 'closed', merged: true, updatedAt: '2026-09-11T00:00:00.000Z' },
      ],
    });

    const incremental = await run({
      tenantId,
      engagementId,
      connectorId: 'github',
      mode: 'incremental',
    });
    expect(incremental.graph.factsSynthesized).toBe(1);
    const rows = await statusChangeFacts(engagementId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ extractionRunId: null });
    expect(rows[0]!.summary).toContain('merged');
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
      createConnectorSyncActivities({
        db: handle.db,
        keyProvider: provider,
        connectors: registry,
        nango: new FakeNangoClient(),
      }).runConnectorSyncActivity as never,
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
      factsSynthesized: 0,
      newWorkItemEntityIds: [],
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
      factsSynthesized: 0,
      newWorkItemEntityIds: [],
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
