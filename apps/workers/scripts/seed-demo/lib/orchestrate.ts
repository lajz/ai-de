import { randomUUID } from 'node:crypto';

import { Connection, WorkflowClient } from '@temporalio/client';
import { MockActivityEnvironment } from '@temporalio/testing';
import { and, eq } from 'drizzle-orm';

import type { EngagementId, TenantId } from '@fde/core';
import {
  ConnectorRegistry,
  FakeGranolaClient,
  FakeLinearClient,
  FakeNangoClient,
  GranolaConnector,
  LinearConnector,
} from '@fde/connectors';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  engagements,
  facts,
  sources,
  tenants,
  upsertConnectorConfig,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';

import {
  createConnectorSyncActivities,
  type RunConnectorSyncResult,
} from '../../../src/activities/connector-sync.js';
import { DEFAULT_TASK_QUEUE } from '../../../src/task-queue.js';
import type {
  ExtractionPipelineWorkflowInput,
  ExtractionPipelineWorkflowResult,
} from '../../../src/workflows/extraction-pipeline.js';
import type { DemoDefinition } from './types.js';

/**
 * Generic seed engine — no literal from any one demo's story lives here.
 * Every demo is a `DemoDefinition` (see `types.ts`); adding a new one never
 * touches this file.
 *
 * Preconditions (not checked beyond `DATABASE_URL` — a clear failure surfaces
 * either way): the local stack is up (Postgres migrated, Temporal reachable),
 * and the real `apps/workers` process is already running a Temporal worker —
 * the extraction step below starts a real `extractionPipelineWorkflow` and
 * waits on its result, which only completes if a worker is polling the task
 * queue.
 */

/** Fixed local tenant every dev-login session resolves to — see `apps/api/src/auth/auth.service.ts`. */
const DEV_TENANT_NAME = 'Local Dev Tenant';

export interface OrchestrateOptions {
  /** delete and fully rebuild this demo's engagement if it already exists */
  reset?: boolean;
}

export async function orchestrate(
  definition: DemoDefinition,
  opts: OrchestrateOptions = {},
): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required — is the local Postgres up?');

  const { db, close } = createDbClient({ url: databaseUrl });
  const provider = new FakeKeyProvider();

  try {
    const tenantId = await ensureDevTenant(db);

    const existing = await findExistingEngagement(db, tenantId, definition.endCustomerName);
    if (existing && !opts.reset) {
      printAlreadyExists(definition, existing);
      return;
    }
    if (existing && opts.reset) {
      console.log(
        `--reset: deleting existing engagement ${existing} (cascades every dependent row)…`,
      );
      await db.delete(engagements).where(eq(engagements.id, existing));
    }

    const engagementId = await createEngagement(db, provider, tenantId, definition.endCustomerName);
    console.log(`created engagement ${engagementId} ("${definition.endCustomerName}")`);

    await seedConnectorConfig(db, provider, tenantId, engagementId, definition.slug);

    // Mutable: reassigned once the decision fact's id is known, below — the
    // Linear sync must run AFTER that, so the marker is baked into the exact
    // issue the sync is about to ingest. Read by the `clientFactory` closure
    // each time it's invoked, not captured at registry-build time.
    let linearIssues = definition.linear.issues;

    const registry = new ConnectorRegistry({
      granola: (ctx) =>
        new GranolaConnector({
          client: new FakeGranolaClient({
            workspaces: [definition.granola.workspace],
            documents: definition.granola.documents,
            transcripts: definition.granola.transcripts,
            bodies: definition.granola.bodies,
          }),
          engagementRetentionPolicy: ctx.engagementRetentionPolicy,
        }),
      linear: (ctx) =>
        new LinearConnector({
          clientFactory: () =>
            new FakeLinearClient({ workspace: definition.linear.workspace, issues: linearIssues }),
          engagementRetentionPolicy: ctx.engagementRetentionPolicy,
        }),
    });
    const nango = new FakeNangoClient({ accessToken: `demo-${definition.slug}-token` });
    // `MockActivityEnvironment` invokes the real `runConnectorSyncActivity` —
    // same technique `connector-sync.integration.test.ts` uses — so this runs
    // the actual `persistGraph` / `upsertEntityByRef` / `resolveEndpointRef` /
    // `upsertRelationship` code path, not a reimplementation of it.
    const acts = createConnectorSyncActivities({
      db,
      keyProvider: provider,
      connectors: registry,
      nango,
    });
    const runSync = (connectorId: string): Promise<RunConnectorSyncResult> =>
      new MockActivityEnvironment().run(
        acts.runConnectorSyncActivity as never,
        {
          tenantId,
          engagementId,
          connectorId,
          mode: 'backfill',
        } as never,
      ) as Promise<RunConnectorSyncResult>;

    console.log('ingesting Granola meetings…');
    const granolaResult = await runSync('granola');
    console.log(
      `  ${granolaResult.sourceCount} source(s) landed, ${granolaResult.transcriptSourceIds.length} with transcripts`,
    );

    console.log(
      'running extraction on each meeting transcript (real LLM calls — waits on a running `apps/workers` Temporal worker)…',
    );
    const extractionRunIdBySourceId = await runExtraction(
      tenantId,
      engagementId,
      granolaResult.transcriptSourceIds,
    );

    console.log(
      `resolving the "${definition.linear.decisionMarker.factType}" fact the marker will point at…`,
    );
    const decisionFactId = await findDecisionFactId(
      db,
      tenantId,
      engagementId,
      definition.linear.decisionMarker,
      extractionRunIdBySourceId,
    );
    console.log(`  fact ${decisionFactId}`);

    linearIssues = definition.linear.issues.map((issue) =>
      issue.id === definition.linear.decisionMarker.issueId
        ? {
            ...issue,
            description: `${issue.description ?? ''}\n\nfde:decision:${decisionFactId}`.trim(),
          }
        : issue,
    );

    console.log('ingesting Linear tickets (with the decision marker baked in)…');
    const linearResult = await runSync('linear');
    console.log(
      `  ${linearResult.sourceCount} source(s) landed, ${linearResult.graph.relationshipsUpserted} relationship(s) upserted, ${linearResult.graph.relationshipsDeferred} deferred`,
    );
    if (linearResult.graph.relationshipsDeferred > 0) {
      console.warn(
        `  ⚠ ${linearResult.graph.relationshipsDeferred} relationship(s) deferred — the decision marker may not have resolved. Check resolveEndpointRef.`,
      );
    }

    printSummary(definition, engagementId, decisionFactId, extractionRunIdBySourceId);
  } finally {
    await close();
  }
}

async function ensureDevTenant(db: Database): Promise<TenantId> {
  const existing = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.name, DEV_TENANT_NAME))
    .limit(1);
  if (existing[0]) return existing[0].id as TenantId;

  const [created] = await db
    .insert(tenants)
    .values({ name: DEV_TENANT_NAME, cmkKeyRef: 'dev:local' })
    .returning({ id: tenants.id });
  return created!.id as TenantId;
}

async function findExistingEngagement(
  db: Database,
  tenantId: TenantId,
  endCustomerName: string,
): Promise<EngagementId | null> {
  const [row] = await db
    .select({ id: engagements.id })
    .from(engagements)
    .where(
      and(eq(engagements.tenantId, tenantId), eq(engagements.endCustomerName, endCustomerName)),
    )
    .limit(1);
  return (row?.id as EngagementId) ?? null;
}

async function createEngagement(
  db: Database,
  provider: FakeKeyProvider,
  tenantId: TenantId,
  endCustomerName: string,
): Promise<EngagementId> {
  const engagementId = randomUUID() as EngagementId;
  const { wrappedDek } = await provider.generateDek({
    tenantId,
    engagementId,
    tenantCmkArn: 'dev:local',
  });
  await db.insert(engagements).values({
    id: engagementId,
    tenantId,
    endCustomerName,
    regionPin: 'us',
    retentionPolicy: 'full-retention',
    status: 'active',
    wrappedDek: Buffer.from(wrappedDek).toString('base64'),
  });
  return engagementId;
}

async function seedConnectorConfig(
  db: Database,
  provider: FakeKeyProvider,
  tenantId: TenantId,
  engagementId: EngagementId,
  slug: string,
): Promise<void> {
  await withEngagement(db, provider, { tenantId, engagementId }, async (tx) => {
    const cipher = getCipher();

    // Never actually read (Granola's connector is constructed with an
    // already-bound `FakeGranolaClient`) — this is purely so the admin
    // connectors page shows "credentialed" rather than blank.
    const granolaCredentialRef = await cipher.encryptString(
      'connector_config.credential_ref',
      `demo-${slug}-granola-placeholder`,
    );
    await upsertConnectorConfig(
      tx,
      { tenantId, engagementId, connector: 'granola' },
      { enabled: true, credentialRef: granolaCredentialRef },
    );

    // This one IS read: Linear's `authKind: 'nango-oauth'` path calls
    // `nango.getConnection(credentialRef, 'linear')` before ingest — the
    // returned token is then ignored by our fixture-bound `clientFactory`.
    const linearCredentialRef = await cipher.encryptString(
      'connector_config.credential_ref',
      `demo-${slug}-linear-connection`,
    );
    await upsertConnectorConfig(
      tx,
      { tenantId, engagementId, connector: 'linear' },
      { enabled: true, credentialRef: linearCredentialRef },
    );
  });
}

/**
 * Starts a real `extractionPipelineWorkflow` per transcript source and waits
 * for each result — matching the `run-extraction.ts` approach proven earlier
 * this session. Requires a real `apps/workers` Temporal worker already
 * polling `taskQueue`.
 */
async function runExtraction(
  tenantId: TenantId,
  engagementId: EngagementId,
  transcriptSourceIds: string[],
): Promise<Map<string, string>> {
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const namespace = process.env.TEMPORAL_NAMESPACE ?? 'default';
  const taskQueue = process.env.TEMPORAL_TASK_QUEUE ?? DEFAULT_TASK_QUEUE;

  const connection = await Connection.connect({ address });
  const client = new WorkflowClient({ connection, namespace });

  const extractionRunIdBySourceId = new Map<string, string>();
  try {
    for (const sourceId of transcriptSourceIds) {
      const input: ExtractionPipelineWorkflowInput = { tenantId, engagementId, sourceId };
      const handle = await client.start('extractionPipelineWorkflow', {
        taskQueue,
        workflowId: `demo-extract-${engagementId}-${sourceId}`,
        args: [input],
      });
      const result = (await handle.result()) as ExtractionPipelineWorkflowResult;
      extractionRunIdBySourceId.set(sourceId, result.extractionRunId);
      console.log(
        `  source ${sourceId}: ${result.factCount} fact(s), ${result.embeddingCount} embedding(s) (run ${result.extractionRunId})`,
      );
    }
  } finally {
    await connection.close();
  }
  return extractionRunIdBySourceId;
}

async function findDecisionFactId(
  db: Database,
  tenantId: TenantId,
  engagementId: EngagementId,
  marker: DemoDefinition['linear']['decisionMarker'],
  extractionRunIdBySourceId: Map<string, string>,
): Promise<string> {
  const [sourceRow] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: sources.id })
      .from(sources)
      .where(
        and(
          eq(sources.engagementId, engagementId),
          eq(sources.connector, 'granola'),
          eq(sources.externalId, marker.sourceDocExternalId),
        ),
      )
      .limit(1),
  );
  if (!sourceRow) {
    throw new Error(
      `no source landed for Granola doc '${marker.sourceDocExternalId}' — did the Granola sync run?`,
    );
  }

  const extractionRunId = extractionRunIdBySourceId.get(sourceRow.id);
  if (!extractionRunId) {
    throw new Error(
      `no extraction ran for source ${sourceRow.id} (doc '${marker.sourceDocExternalId}')`,
    );
  }

  const [factRow] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({ id: facts.id, summary: facts.summary })
      .from(facts)
      .where(
        and(
          eq(facts.engagementId, engagementId),
          eq(facts.extractionRunId, extractionRunId),
          eq(facts.type, marker.factType),
        ),
      )
      .limit(1),
  );
  if (!factRow) {
    throw new Error(
      `extraction of '${marker.sourceDocExternalId}' did not produce a '${marker.factType}' fact — inspect ` +
        `the transcript or rerun. This is real LLM output and isn't 100% guaranteed on every run; the script ` +
        `refuses to fall back to a dangling marker (the exact bug this demo dataset exists to prove is fixed).`,
    );
  }
  console.log(`    "${factRow.summary}"`);
  return factRow.id;
}

function printAlreadyExists(definition: DemoDefinition, engagementId: EngagementId): void {
  console.log(
    `demo "${definition.slug}" already exists — engagement ${engagementId} ("${definition.endCustomerName}")`,
  );
  console.log('rerun with --reset to delete and fully rebuild it.');
  printUrls(engagementId);
}

function printSummary(
  definition: DemoDefinition,
  engagementId: EngagementId,
  decisionFactId: string,
  extractionRunIdBySourceId: Map<string, string>,
): void {
  console.log('');
  console.log(
    `✓ demo "${definition.slug}" seeded — engagement ${engagementId} ("${definition.endCustomerName}")`,
  );
  console.log(`  decision fact: ${decisionFactId}`);
  console.log(`  extraction runs: ${extractionRunIdBySourceId.size}`);
  printUrls(engagementId);
  console.log('');
  console.log('Ask panel questions to try:');
  for (const q of definition.qaQuestions) {
    const hint = q.expectNoAnswer ? ' (expect: "That is not in the retrieved context.")' : '';
    console.log(`  - ${q.question}${hint}`);
  }
}

function printUrls(engagementId: EngagementId): void {
  const base = process.env.DEMO_WEB_BASE_URL ?? 'http://localhost:3001';
  console.log(`  ${base}/`);
  console.log(`  ${base}/engagements/${engagementId}`);
  console.log(`  ${base}/engagements/${engagementId}/admin/connectors`);
  console.log(`  ${base}/engagements/${engagementId}/admin/lineage`);
  console.log(`  ${base}/engagements/${engagementId}/admin/graph`);
  console.log(`  ${base}/engagements/${engagementId}/admin/pipeline`);
}
