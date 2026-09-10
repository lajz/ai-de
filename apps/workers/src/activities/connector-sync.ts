import { ApplicationFailure, Context, heartbeat, log } from '@temporalio/activity';
import { and, eq } from 'drizzle-orm';

import type {
  CanonicalRecord,
  Connector,
  ConnectorContext,
  EngagementId,
  RawArtifact,
  RetentionPolicy,
  TenantId,
} from '@fde/core';
import { rawArtifactSchema } from '@fde/core';
import { encryptRow, type KeyProvider } from '@fde/crypto';
import {
  aclSnapshots,
  connectorSyncState,
  CRYPTO_COLUMNS,
  engagements,
  resolveEndpointRef,
  sources,
  upsertEntityByRef,
  upsertRelationship,
  withTenant,
  type Database,
} from '@fde/db';
import { resolveNormalizedRecords } from '@fde/identity';
import { type ConnectorRegistry } from '@fde/connectors';

import { buildConnectorSource, connectorContentHash } from './connector-source.js';
import { withEngagementActivity, type EngagementActivityContext } from './engagement-context.js';

export interface ConnectorSyncActivitiesDeps {
  db: Database;
  keyProvider: KeyProvider;
  /** connector id → factory; built in `worker.ts` (`createDefaultConnectorRegistry`) */
  connectors: ConnectorRegistry;
}

export type ConnectorSyncMode = 'backfill' | 'incremental';

export interface RunConnectorSyncInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  connectorId: string;
  mode: ConnectorSyncMode;
}

export interface RunConnectorSyncResult {
  connectorId: string;
  mode: ConnectorSyncMode;
  /** artifacts streamed from the connector this run */
  artifactCount: number;
  /** `sources` rows actually inserted (dedupe hits excluded) */
  sourceCount: number;
  /** transcript sources that newly landed — the workflow starts extraction for each */
  transcriptSourceIds: string[];
  /** the cursor after this run, or null if the connector never checkpointed */
  cursor: string | null;
  /** canonical-graph write tally (metadata only) — see `GraphWriteTally` */
  graph: GraphWriteTally;
}

/**
 * Metadata-only counts from persisting one run's `normalize` output. No entity
 * names, refs, or bodies — safe to log and to return in workflow history.
 */
export interface GraphWriteTally {
  /** `person` / `organization` records run through `@fde/identity`'s `resolveEntity` */
  entitiesResolved: number;
  /** `work_item` / `document` / `meeting` records upserted by external ref */
  entitiesUpserted: number;
  /** `relationship` edges newly inserted (dedupe hits excluded) */
  relationshipsUpserted: number;
  /** `relationship` edges skipped because an endpoint ref did not resolve yet */
  relationshipsDeferred: number;
  /** near-duplicate person pairs newly enqueued for human review */
  matchCandidatesQueued: number;
}

const ZERO_TALLY: GraphWriteTally = {
  entitiesResolved: 0,
  entitiesUpserted: 0,
  relationshipsUpserted: 0,
  relationshipsDeferred: 0,
  matchCandidatesQueued: 0,
};

const addTally = (a: GraphWriteTally, b: GraphWriteTally): GraphWriteTally => ({
  entitiesResolved: a.entitiesResolved + b.entitiesResolved,
  entitiesUpserted: a.entitiesUpserted + b.entitiesUpserted,
  relationshipsUpserted: a.relationshipsUpserted + b.relationshipsUpserted,
  relationshipsDeferred: a.relationshipsDeferred + b.relationshipsDeferred,
  matchCandidatesQueued: a.matchCandidatesQueued + b.matchCandidatesQueued,
});

/**
 * Persist the canonical graph one artifact's `normalize` produced, inside the
 * caller's engagement transaction (same `ctx.tx` / `ctx.cipher` that just landed
 * the `sources` row).
 *
 * - `person` / `organization` → `@fde/identity`'s `resolveNormalizedRecords`
 *   (deterministic identity-tier upsert into `entities` + a fuzzy-match scan that
 *   enqueues near-duplicates for human review — it never auto-merges).
 * - `work_item` / `document` / `meeting` → `upsertEntityByRef` (external-ref key).
 * - `relationship` → resolve both endpoints against entities already in the graph;
 *   insert the edge (stamped with `sourceId`) only if BOTH resolve. An edge whose
 *   endpoint has not been created yet is skipped and counted — a later artifact in
 *   this or a subsequent run may create it. v1 has no reconciliation pass that
 *   retries a deferred edge; that is a documented follow-up.
 *
 * Entities are written before relationships so an edge between two nodes named in
 * the *same* artifact resolves within this call. `normalize` is pure (the
 * `Connector` contract), so re-running it on a re-ingested artifact is safe; each
 * helper is idempotent, so a second sync run adds no duplicate rows.
 */
async function persistGraph(
  ctx: EngagementActivityContext,
  connector: Connector,
  artifact: RawArtifact,
  sourceId: string,
  connectorId: string,
): Promise<GraphWriteTally> {
  const records: CanonicalRecord[] = connector.normalize(artifact);
  const tally: GraphWriteTally = { ...ZERO_TALLY };

  // person / organization — @fde/identity owns the identity tiers + review queue
  const resolved = await resolveNormalizedRecords(ctx.tx, ctx.tenantId, ctx.engagementId, records);
  tally.entitiesResolved = resolved.length;
  tally.matchCandidatesQueued = resolved.reduce(
    (n, r) => n + r.candidates.filter((c) => c.queued).length,
    0,
  );

  // work_item / document / meeting — keyed directly by external ref
  for (const rec of records) {
    if (rec.kind !== 'entity') continue;
    if (rec.type === 'person' || rec.type === 'organization') continue;
    await upsertEntityByRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec, ctx.cipher);
    tally.entitiesUpserted += 1;
  }

  // relationships — both endpoints must already exist in the graph
  for (const rec of records) {
    if (rec.kind !== 'relationship') continue;
    const from = await resolveEndpointRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec.from);
    const to = await resolveEndpointRef(ctx.tx, ctx.tenantId, ctx.engagementId, rec.to);
    if (!from || !to) {
      tally.relationshipsDeferred += 1;
      continue;
    }
    const { inserted } = await upsertRelationship(ctx.tx, ctx.tenantId, ctx.engagementId, {
      fromKind: from.kind,
      fromId: from.id,
      predicate: rec.predicate,
      toKind: to.kind,
      toId: to.id,
      sourceId,
    });
    if (inserted) tally.relationshipsUpserted += 1;
  }

  // metadata-only: counts, never entity names / refs / bodies
  log.info(`connector.${connectorId}.graph_persisted`, { ...tally, connectorId });
  return tally;
}

type SyncStatePatch = Partial<{
  status: 'idle' | 'running' | 'error';
  cursor: string | null;
  lastRunAt: Date;
}>;

/**
 * The generic `ConnectorSync` activities — reused by every direct/Nango
 * connector (Granola for M2, Linear for M3). DI point for `db` / `keyProvider` /
 * `connectors`.
 *
 * Ids-only payload: the workflow hands `runConnectorSyncActivity`
 * `{ tenantId, engagementId, connectorId, mode }`. Every artifact body is
 * fetched, encrypted, and written **entirely inside this activity** — it never
 * crosses the workflow↔activity boundary (`docs/architecture.md`: "Temporal
 * payloads carry ids, never bodies").
 *
 * RLS boundary: this activity NEVER issues a bare `deps.db` query. Every read
 * and write goes through `withTenant(deps.db, tenantId, …)` (the engagement +
 * cursor read, `upsertSyncState`) or `withEngagementActivity(deps.db,
 * keyProvider, {tenantId, engagementId}, …)` (`ingestArtifact` — the encrypted
 * writes), each of which does `SET LOCAL ROLE app_rw` + `app.tenant_id` so
 * Postgres RLS scopes the session. The ids come from the workflow input, which
 * is itself started only from an authenticated request path.
 */
export function createConnectorSyncActivities(deps: ConnectorSyncActivitiesDeps) {
  async function upsertSyncState(
    tenantId: TenantId,
    engagementId: EngagementId,
    connector: string,
    patch: SyncStatePatch,
  ): Promise<void> {
    await withTenant(deps.db, tenantId, (tx) =>
      tx
        .insert(connectorSyncState)
        .values({
          tenantId,
          engagementId,
          connector,
          cursor: patch.cursor ?? null,
          status: patch.status ?? 'running',
          lastRunAt: patch.lastRunAt ?? null,
        })
        .onConflictDoUpdate({
          target: [connectorSyncState.engagementId, connectorSyncState.connector],
          set: { ...patch, updatedAt: new Date() },
        }),
    );
  }

  /** Persist one artifact: dedupe → resolveAcl → acl_snapshots → encrypted sources row → canonical graph. */
  async function ingestArtifact(
    connector: Connector,
    ctx: ConnectorContext,
    rawArtifact: RawArtifact,
    meta: {
      tenantId: TenantId;
      engagementId: EngagementId;
      connectorId: string;
      retentionPolicy: RetentionPolicy;
    },
  ): Promise<{
    inserted: boolean;
    sourceId: string;
    kind: RawArtifact['kind'];
    graph: GraphWriteTally;
  }> {
    const artifact = rawArtifactSchema.parse(rawArtifact);
    const contentHash = connectorContentHash(artifact);
    // tenantId is redundant under RLS (`withTenant` / `withEngagementActivity`
    // both scope the session) but kept explicit, matching the rest of the
    // codebase — defence in depth, not the only guard.
    const dedupe = and(
      eq(sources.tenantId, meta.tenantId),
      eq(sources.engagementId, meta.engagementId),
      eq(sources.connector, meta.connectorId),
      eq(sources.externalId, artifact.externalId),
      eq(sources.contentHash, contentHash),
    );

    // Cheap pre-check outside the crypto path — a re-run skips the DEK unwrap +
    // the connector's ACL fetch for artifacts already ingested.
    const existingId = await withTenant(deps.db, meta.tenantId, async (tx) => {
      const [row] = await tx.select({ id: sources.id }).from(sources).where(dedupe).limit(1);
      return row?.id ?? null;
    });
    if (existingId)
      return { inserted: false, sourceId: existingId, kind: artifact.kind, graph: ZERO_TALLY };

    // Origin-system ACL — a plain connector read, kept out of the engagement
    // transaction so the `FOR SHARE` lock isn't held across a network call.
    const snapshot = await connector.resolveAcl(ctx, artifact);

    return withEngagementActivity(
      deps.db,
      deps.keyProvider,
      { tenantId: meta.tenantId, engagementId: meta.engagementId },
      async (c) => {
        // Re-check inside the tx — guards the (rare, single-workflow) concurrent race.
        const [again] = await c.tx.select({ id: sources.id }).from(sources).where(dedupe).limit(1);
        if (again)
          return { inserted: false, sourceId: again.id, kind: artifact.kind, graph: ZERO_TALLY };

        // 1. sources row first (acl_snapshot_id null) — so a conflict here never
        //    orphans an acl_snapshots row.
        const built = await buildConnectorSource(c.cipher, {
          tenantId: meta.tenantId,
          engagementId: meta.engagementId,
          artifact,
          retentionPolicy: meta.retentionPolicy,
          aclSnapshotId: null,
        });
        const [srcRow] = await c.tx
          .insert(sources)
          .values(built.row)
          .onConflictDoNothing({
            target: [
              sources.engagementId,
              sources.connector,
              sources.externalId,
              sources.contentHash,
            ],
          })
          .returning({ id: sources.id });
        if (!srcRow) {
          // Lost a race to a concurrent writer between the re-check and the
          // insert. The winner owns the acl_snapshot + extraction hand-off for
          // this source; report it as an existing row.
          const [raced] = await c.tx
            .select({ id: sources.id })
            .from(sources)
            .where(dedupe)
            .limit(1);
          return {
            inserted: false,
            sourceId: raced?.id ?? '',
            kind: artifact.kind,
            graph: ZERO_TALLY,
          };
        }

        // 2. encrypted ACL snapshot, linked back onto the source.
        const aclRow = await encryptRow(c.cipher, CRYPTO_COLUMNS.acl_snapshots, {
          principalRules: snapshot.rules,
        });
        const [aclInserted] = await c.tx
          .insert(aclSnapshots)
          .values({
            tenantId: meta.tenantId,
            engagementId: meta.engagementId,
            sourceRef: `${meta.connectorId}:${artifact.externalId}`,
            principalRules: aclRow.principalRules,
            capturedAt: new Date(snapshot.capturedAt),
            ttlSeconds: snapshot.ttlSeconds,
          })
          .returning({ id: aclSnapshots.id });
        if (!aclInserted) throw new Error('connector-sync: acl_snapshots insert returned no row');

        await c.tx
          .update(sources)
          .set({ aclSnapshotId: aclInserted.id })
          .where(and(eq(sources.id, srcRow.id), eq(sources.engagementId, meta.engagementId)));

        // 3. canonical graph — `normalize` output persisted in the same tx, so a
        //    crash rolls the source back with it (no half-ingested artifact).
        const graph = await persistGraph(c, connector, artifact, srcRow.id, meta.connectorId);

        return { inserted: true, sourceId: srcRow.id, kind: artifact.kind, graph };
      },
    );
  }

  async function runConnectorSyncActivity(
    input: RunConnectorSyncInput,
  ): Promise<RunConnectorSyncResult> {
    const { tenantId, engagementId, connectorId, mode } = input;

    if (!deps.connectors.has(connectorId)) {
      throw ApplicationFailure.create({
        type: 'UnknownConnector',
        message: `no connector registered for '${connectorId}'`,
        nonRetryable: true,
      });
    }

    // Engagement retention policy + the persisted cursor, in one tenant-scoped read.
    const { retentionPolicy, cursor: persistedCursor } = await withTenant(
      deps.db,
      tenantId,
      async (tx) => {
        const [eng] = await tx
          .select({ retentionPolicy: engagements.retentionPolicy, status: engagements.status })
          .from(engagements)
          .where(eq(engagements.id, engagementId))
          .limit(1);
        if (!eng) {
          throw ApplicationFailure.create({
            type: 'EngagementNotFound',
            message: `engagement ${engagementId} not found`,
            nonRetryable: true,
          });
        }
        if (eng.status !== 'active') {
          throw ApplicationFailure.create({
            type: 'EngagementNotActive',
            message: `engagement ${engagementId} is ${eng.status}`,
            nonRetryable: true,
          });
        }
        const [state] = await tx
          .select({ cursor: connectorSyncState.cursor })
          .from(connectorSyncState)
          .where(
            and(
              eq(connectorSyncState.engagementId, engagementId),
              eq(connectorSyncState.connector, connectorId),
            ),
          )
          .limit(1);
        return {
          retentionPolicy: eng.retentionPolicy as RetentionPolicy,
          cursor: state?.cursor ?? null,
        };
      },
    );

    // `backfill` always re-imports from the start (the interface has no cursor
    // param); dedupe on `(engagement, connector, external_id, content_hash)`
    // keeps a re-run — or a mid-run crash + Temporal retry — from duplicating
    // `sources`. `incremental` resumes from the persisted cursor.
    const fromCursor = mode === 'incremental' ? persistedCursor : null;

    const connector = deps.connectors.build(connectorId, {
      engagementRetentionPolicy: retentionPolicy,
    });
    const effectiveRetentionPolicy = connector.retentionPolicy;

    await upsertSyncState(tenantId, engagementId, connectorId, {
      status: 'running',
      lastRunAt: new Date(),
    });

    const ctx: ConnectorContext = {
      tenantId,
      engagementId,
      getCredential: () =>
        Promise.reject(
          new Error(
            'ConnectorSync injects a pre-authed client (e.g. GRANOLA_API_KEY); ' +
              'the vault-backed getCredential path lands with Nango in M3',
          ),
        ),
      // structured log sink — connectors MUST NOT pass artifact bodies here
      // (see the `Connector` interface).
      log: (event, fields) =>
        log.info(`connector.${connectorId}.${event}`, { ...fields, connectorId }),
      signal: Context.current().cancellationSignal,
    };

    const emits =
      mode === 'backfill' ? connector.backfill(ctx) : connector.incremental(ctx, fromCursor);

    let artifactCount = 0;
    let sourceCount = 0;
    let cursor = fromCursor;
    let graph: GraphWriteTally = { ...ZERO_TALLY };
    const transcriptSourceIds: string[] = [];

    try {
      for await (const emit of emits) {
        heartbeat({ artifactCount, sourceCount });
        if (emit.type === 'checkpoint') {
          cursor = emit.cursor;
          await upsertSyncState(tenantId, engagementId, connectorId, { cursor });
          continue;
        }
        artifactCount += 1;
        const landed = await ingestArtifact(connector, ctx, emit.artifact, {
          tenantId,
          engagementId,
          connectorId,
          retentionPolicy: effectiveRetentionPolicy,
        });
        graph = addTally(graph, landed.graph);
        if (landed.inserted) {
          sourceCount += 1;
          if (landed.kind === 'transcript') transcriptSourceIds.push(landed.sourceId);
        }
      }
    } catch (err) {
      await upsertSyncState(tenantId, engagementId, connectorId, { status: 'error' });
      throw err;
    }

    await upsertSyncState(tenantId, engagementId, connectorId, {
      status: 'idle',
      cursor,
      lastRunAt: new Date(),
    });

    return { connectorId, mode, artifactCount, sourceCount, transcriptSourceIds, cursor, graph };
  }

  return { runConnectorSyncActivity };
}

export type ConnectorSyncActivities = ReturnType<typeof createConnectorSyncActivities>;
