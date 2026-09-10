import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, TenantId } from '@fde/core';
import { EngagementCipher, EngagementShreddedError, FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  accessLog,
  captureSessions,
  createDbClient,
  embeddings,
  engagements,
  evidence,
  extractionRuns,
  facts,
  selectEngagementFacts,
  selectEvidenceForFacts,
  shredEngagement,
  sources,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import { ConnectorRegistry, FakeNangoClient } from '@fde/connectors';
import { EMBEDDING_DIM, FakeEmbeddingClient, NoopTracer } from '@fde/llm';
import { createActivities } from '@fde/workers/activities/index.js';
import { FakeRecallClient } from '@fde/workers/capture/index.js';
import { Client, Connection } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { NativeConnection, Worker } from '@temporalio/worker';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCannedExtractionRouter } from './fixtures/canned-router.js';
import {
  EXPECTED_FACTS,
  FIXTURE_MEETING_URL,
  FIXTURE_SEGMENTS,
  FIXTURE_TRANSCRIPT_TEXT,
} from './fixtures/meeting-transcript.js';

// Needs the e2e compose stack (`docker-compose.e2e.yml`) — a migrated + hardened
// Postgres, and a Temporal dev server. Skipped unless DATABASE_URL is set; see
// `docs/testing.md`. Not part of `pnpm test` (its own `pnpm e2e` / vitest
// project).
//
// Temporal: connects to `TEMPORAL_ADDRESS` when set (the compose dev server, as
// CI runs it); otherwise spins up an in-process `TestWorkflowEnvironment` — the
// same `temporal server start-dev` binary — so a dev with just Postgres can run
// `pnpm e2e` without the container.
const DATABASE_URL = process.env.DATABASE_URL;
const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS;
const TEMPORAL_NAMESPACE = process.env.TEMPORAL_NAMESPACE ?? 'default';

const workflowsPath = fileURLToPath(
  new URL('../apps/workers/src/workflows/index.ts', import.meta.url),
);

/** phrases that must never appear in a ciphertext column read raw */
const SECRET_PHRASES = [
  'Postgres',
  'DynamoDB',
  'runbook',
  'identity provider',
  'claims-intake',
  'Northwind',
];

function expectNoPlaintext(bytes: Buffer): void {
  const utf8 = bytes.toString('utf8');
  for (const phrase of SECRET_PHRASES) {
    expect(utf8).not.toContain(phrase);
  }
}

/** poll `fn` until it returns something truthy, or time out */
async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined>,
  { timeoutMs = 60_000, everyMs = 500 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor(${what}): timed out after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describe.skipIf(!DATABASE_URL)('M1 pipeline e2e (capture → extraction → read path)', () => {
  const provider = new FakeKeyProvider();
  const taskQueue = `e2e-${randomUUID()}`;

  let handle: { db: Database; close: () => Promise<void> };
  let testEnv: TestWorkflowEnvironment | undefined;
  let nativeConn: NativeConnection | undefined;
  let clientConn: Connection | undefined;
  let client: Client;
  let worker: Worker;
  let workerRun: Promise<void>;
  let activities: ReturnType<typeof createActivities>;

  // tenant A runs the pipeline; tenant B exists only to prove isolation
  const tenantA = randomUUID() as TenantId;
  const tenantB = randomUUID() as TenantId;
  const engagementA = randomUUID() as EngagementId;
  const engagementB = randomUUID() as EngagementId;

  // set by the first test, read by the rest
  let sourceId: string;
  let extractionRunId: string;

  async function seedEngagement(
    tenantId: TenantId,
    engagementId: EngagementId,
    retentionPolicy: 'full-retention' | 'derived-ephemeral-raw',
  ): Promise<void> {
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
      retentionPolicy,
      wrappedDek: Buffer.from(wrappedDek).toString('base64'),
    });
  }

  beforeAll(async () => {
    handle = createDbClient({ url: DATABASE_URL!, max: 4 });

    // seed on the superuser connection (bypasses RLS), same as the other
    // integration suites
    await handle.db.insert(tenants).values([
      { id: tenantA, name: 'Tenant A', cmkKeyRef: 'fake:a' },
      { id: tenantB, name: 'Tenant B', cmkKeyRef: 'fake:b' },
    ]);
    await seedEngagement(tenantA, engagementA, 'derived-ephemeral-raw');
    await seedEngagement(tenantB, engagementB, 'full-retention');

    let workerConnection: NativeConnection;
    if (TEMPORAL_ADDRESS) {
      nativeConn = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });
      clientConn = await Connection.connect({ address: TEMPORAL_ADDRESS });
      client = new Client({ connection: clientConn, namespace: TEMPORAL_NAMESPACE });
      workerConnection = nativeConn;
    } else {
      testEnv = await TestWorkflowEnvironment.createLocal();
      client = testEnv.client;
      workerConnection = testEnv.nativeConnection;
    }

    activities = createActivities({
      db: handle.db,
      keyProvider: provider,
      // feed the fixture transcript through the deterministic Recall stand-in
      recallClient: new FakeRecallClient({ transcript: FIXTURE_SEGMENTS, pollsUntilDone: 1 }),
      // deterministic extraction — quality is @fde/eval's job, not this test's
      router: createCannedExtractionRouter(),
      embeddingClient: new FakeEmbeddingClient(),
      tracer: new NoopTracer(),
      // this pipeline is capture -> extraction -> read; no connector sync runs here
      connectors: new ConnectorRegistry({}),
      nango: new FakeNangoClient(),
    });

    worker = await Worker.create({
      connection: workerConnection,
      namespace: TEMPORAL_NAMESPACE,
      taskQueue,
      workflowsPath,
      activities,
    });
    workerRun = worker.run();
  }, 180_000);

  afterAll(async () => {
    worker?.shutdown();
    await workerRun?.catch(() => {});
    await nativeConn?.close();
    await clientConn?.close();
    await testEnv?.teardown();
    if (handle) {
      // Cleanup on the superuser connection, scoped to this run's two random
      // tenant ids only — never a schema-wide TRUNCATE, since in the
      // no-container fallback `DATABASE_URL` may point at a shared dev database.
      // `access_log` is append-only for `app_rw` (DELETE is revoked), so this
      // one delete cannot go through `withTenant`; it is a sanctioned teardown
      // exception. Deleting an engagement cascades to every other
      // engagement-scoped row, but `access_log` is not cascaded (`engagement_id`
      // is `set null`, `tenant_id` is `restrict`) — so clear the audit rows
      // first, then engagements, then tenants.
      const ids = sql`in (${tenantA}, ${tenantB})`;
      await handle.db.delete(accessLog).where(sql`${accessLog.tenantId} ${ids}`);
      await handle.db.delete(engagements).where(sql`${engagements.tenantId} ${ids}`);
      await handle.db.delete(tenants).where(sql`${tenants.id} ${ids}`);
      await handle.close();
    }
  });

  it('capture lands an encrypted transcript and auto-triggers extraction onto the spine', async () => {
    // ---- capture (the only workflow this test starts) ---------------------
    const capture = (await client.workflow.execute('captureSessionWorkflow', {
      taskQueue,
      workflowId: `e2e-capture-${engagementA}`,
      args: [
        {
          tenantId: tenantA,
          engagementId: engagementA,
          meetingUrl: FIXTURE_MEETING_URL,
          joinAt: new Date().toISOString(),
          retentionPolicy: 'derived-ephemeral-raw',
          pollIntervalSeconds: 1,
          maxPollAttempts: 3,
        },
      ],
    })) as { sourceId: string; bodyRetained: boolean; extractionWorkflowId: string | null };

    expect(capture.bodyRetained).toBe(true);
    sourceId = capture.sourceId;

    // capture auto-started the extraction child (keyed off the idempotent sourceId)
    expect(capture.extractionWorkflowId).toBe(`extraction-${sourceId}`);

    // the permalink is stored cleartext and is the real meeting URL
    const [srcMeta] = await handle.db
      .select({ permalink: sources.urlPermalink, rawBody: sql<Buffer>`${sources.rawBody}` })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(srcMeta!.permalink).toBe(FIXTURE_MEETING_URL);

    // raw transcript bytes are ciphertext, not the meeting content
    expectNoPlaintext(srcMeta!.rawBody);

    // and are undecryptable with the wrong DEK
    const wrongCipher = new EngagementCipher(tenantA, engagementA, new Uint8Array(randomBytes(32)));
    await expect(
      wrongCipher.decryptString('sources.raw_body', srcMeta!.rawBody as never),
    ).rejects.toThrow();

    // the app path with the engagement DEK round-trips to the transcript
    const decrypted = await withEngagement(
      handle.db,
      provider,
      { tenantId: tenantA, engagementId: engagementA },
      async (tx) => {
        const [row] = await tx
          .select({ rawBody: sources.rawBody })
          .from(sources)
          .where(eq(sources.id, sourceId));
        return getCipher().decryptString('sources.raw_body', row!.rawBody!);
      },
    );
    expect(decrypted).toBe(FIXTURE_TRANSCRIPT_TEXT);

    // ---- wait on the auto-triggered extraction --------------------------
    // The child runs detached (ABANDON) and, under `derived-ephemeral-raw`,
    // then sleeps on a ~7-day purge timer — so wait on the committed
    // `extraction_runs` row (cost_usd is the pipeline's final write), not on
    // the child workflow result.
    const runRow = await waitFor('extraction_runs committed', async () => {
      const [r] = await handle.db
        .select({ id: extractionRuns.id, model: extractionRuns.model })
        .from(extractionRuns)
        .where(
          and(
            eq(extractionRuns.engagementId, engagementA),
            sql`${extractionRuns.costUsd} is not null`,
          ),
        );
      return r ?? null;
    });
    extractionRunId = runRow.id;
    expect(runRow.model).toBe('claude-sonnet-5');

    // ---- assert the rows on the security spine ---------------------------
    const seen = await withEngagement(
      handle.db,
      provider,
      { tenantId: tenantA, engagementId: engagementA },
      async (tx) => {
        const cipher = getCipher();
        const factRows = await tx
          .select({ id: facts.id, type: facts.type, summary: facts.summary, body: facts.body })
          .from(facts)
          .where(eq(facts.extractionRunId, extractionRunId));
        const decryptedFacts = await Promise.all(
          factRows.map(async (f) => ({
            type: f.type,
            summary: f.summary,
            body: f.body ? await cipher.decryptString('facts.body', f.body) : null,
          })),
        );
        const citations = await selectEvidenceForFacts(
          tx,
          tenantA,
          engagementA,
          factRows.map((f) => f.id),
        );
        const decryptedQuotes = await Promise.all(
          citations.map(async (c) => ({
            ...c,
            quote: c.quote ? await cipher.decryptString('evidence.quote', c.quote) : null,
          })),
        );
        const embRows = await tx.select().from(embeddings).where(eq(embeddings.sourceId, sourceId));
        const [runRow] = await tx
          .select()
          .from(extractionRuns)
          .where(eq(extractionRuns.id, extractionRunId));
        return { decryptedFacts, citations: decryptedQuotes, embRows, runRow };
      },
    );

    // every expected fact type + phrase came through
    expect(seen.decryptedFacts).toHaveLength(EXPECTED_FACTS.length);
    for (const expected of EXPECTED_FACTS) {
      const match = seen.decryptedFacts.find(
        (f) => f.type === expected.type && f.body === expected.detail,
      );
      expect(match, `fact for ${JSON.stringify(expected.quote)}`).toBeTruthy();
      expect(match!.summary).toContain(expected.summaryPhrase);
    }

    // evidence links to the transcript source with spans that resolve verbatim
    expect(seen.citations).toHaveLength(EXPECTED_FACTS.length);
    for (const c of seen.citations) {
      expect(c.sourceId).toBe(sourceId);
      expect(c.permalink).toBe(FIXTURE_MEETING_URL);
      expect(c.charStart).not.toBeNull();
      expect(c.charEnd).not.toBeNull();
      expect(FIXTURE_TRANSCRIPT_TEXT.slice(c.charStart!, c.charEnd!)).toBe(c.quote);
      expect(EXPECTED_FACTS.some((e) => e.quote === c.quote)).toBe(true);
    }

    // embeddings at the pgvector dimension
    expect(seen.embRows).toHaveLength(1);
    expect(seen.embRows[0]!.embedding).toHaveLength(EMBEDDING_DIM);
    expect(EMBEDDING_DIM).toBe(1024);
    expect(seen.embRows[0]!.model).toBe('fake-deterministic');

    // the run is stamped
    expect(seen.runRow).toMatchObject({
      model: 'claude-sonnet-5',
      inputSourceIds: [sourceId],
    });
    expect(seen.runRow!.costUsd).not.toBeNull();

    // ---- field encryption at rest --------------------------------------
    const rawFactBodies = await handle.db
      .select({ b: sql<Buffer>`${facts.body}` })
      .from(facts)
      .where(and(eq(facts.extractionRunId, extractionRunId), sql`${facts.body} is not null`));
    expect(rawFactBodies.length).toBeGreaterThan(0);
    for (const r of rawFactBodies) expectNoPlaintext(r.b);

    const rawQuotes = await handle.db
      .select({ q: sql<Buffer>`${evidence.quote}` })
      .from(evidence)
      .where(
        and(eq(evidence.extractionRunId, extractionRunId), sql`${evidence.quote} is not null`),
      );
    expect(rawQuotes.length).toBe(EXPECTED_FACTS.length);
    for (const r of rawQuotes) expectNoPlaintext(r.q);

    // ---- derived-ephemeral-raw: the raw body is purged after the window --
    // The extraction child owns the durable purge timer — a ~7-day sleep in
    // prod, too long to wait out against a real Temporal server. The timer
    // arithmetic itself is unit-tested (apps/workers … extraction-pipeline.test
    // "waits out the purge timer"); here we bring the deadline into the past and
    // run the exact activity the timer fires, whose own guards (`cost_usd` set,
    // deadline elapsed) still have to pass.
    await withTenant(handle.db, tenantA, (tx) =>
      tx
        .update(captureSessions)
        .set({ purgeRawAfter: new Date(Date.now() - 60_000) })
        .where(eq(captureSessions.sourceId, sourceId)),
    );
    const purge = await activities.purgeRawBodyActivity({
      tenantId: tenantA,
      engagementId: engagementA,
      sourceId,
      extractionRunId,
    });
    expect(purge).toEqual({ purged: true });

    const [afterPurge] = await handle.db
      .select({ rawBody: sources.rawBody })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(afterPurge!.rawBody).toBeNull();
  }, 120_000);

  it('tenant B cannot read tenant A facts (RLS)', async () => {
    // control: tenant A sees its own facts
    const asA = await withTenant(handle.db, tenantA, (tx) =>
      selectEngagementFacts(tx, tenantA, engagementA),
    );
    expect(asA.length).toBe(EXPECTED_FACTS.length);

    // tenant B, asking for tenant A's engagement — RLS returns nothing, no error
    const asB = await withTenant(handle.db, tenantB, (tx) =>
      selectEngagementFacts(tx, tenantB, engagementA),
    );
    expect(asB).toEqual([]);

    // even a raw predicate on the engagement id is invisible cross-tenant
    const rawCross = await withTenant(handle.db, tenantB, (tx) =>
      tx.select({ id: facts.id }).from(facts).where(eq(facts.engagementId, engagementA)),
    );
    expect(rawCross).toEqual([]);
  });

  it('read path returns decrypted facts with citations that resolve to the source', async () => {
    // The engagement read path is `withEngagement` → the `@fde/db` retrieval
    // helpers → decrypt post-gate. This is exactly what `apps/api`'s
    // `GET /engagements/:id/facts` does over HTTP; the full HTTP + WorkOS +
    // authz path is covered by `apps/api/src/retrieval/retrieval.e2e.test.ts`.
    const view = await withEngagement(
      handle.db,
      provider,
      { tenantId: tenantA, engagementId: engagementA },
      async (tx) => {
        const cipher = getCipher();
        const factList = await selectEngagementFacts(tx, tenantA, engagementA);
        const cites = await selectEvidenceForFacts(
          tx,
          tenantA,
          engagementA,
          factList.map((f) => f.id),
        );
        return Promise.all(
          factList.map(async (f) => ({
            type: f.type,
            summary: f.summary,
            body: f.body ? await cipher.decryptString('facts.body', f.body) : null,
            citations: await Promise.all(
              cites
                .filter((c) => c.factId === f.id)
                .map(async (c) => ({
                  permalink: c.permalink,
                  charStart: c.charStart,
                  charEnd: c.charEnd,
                  quote: c.quote ? await cipher.decryptString('evidence.quote', c.quote) : null,
                })),
            ),
          })),
        );
      },
    );

    expect(view).toHaveLength(EXPECTED_FACTS.length);
    const decision = view.find((f) => f.type === 'decision' && (f.body ?? '').includes('Postgres'));
    expect(decision).toBeTruthy();
    const cite = decision!.citations[0]!;
    expect(cite.permalink).toBe(FIXTURE_MEETING_URL);
    expect(FIXTURE_TRANSCRIPT_TEXT.slice(cite.charStart!, cite.charEnd!)).toBe(cite.quote);
  });

  it('crypto-shred makes every 🔒 field undecryptable and writes an access_log entry', async () => {
    const did = await shredEngagement(handle.db, {
      tenantId: tenantA,
      engagementId: engagementA,
      actorId: 'e2e-admin',
      reason: 'M1 e2e crypto-shred assertion',
    });
    expect(did).toBe(true);

    // withEngagement now fails closed — the wrapped DEK is gone
    await expect(
      withEngagement(
        handle.db,
        provider,
        { tenantId: tenantA, engagementId: engagementA },
        async () => undefined,
      ),
    ).rejects.toBeInstanceOf(EngagementShreddedError);

    // the read path is closed too: the engagement-scoped fact read can no longer
    // reach plaintext (it opens `withEngagement`, which now throws before any row
    // is decrypted).
    await expect(
      withEngagement(handle.db, provider, { tenantId: tenantA, engagementId: engagementA }, (tx) =>
        selectEngagementFacts(tx, tenantA, engagementA),
      ),
    ).rejects.toBeInstanceOf(EngagementShreddedError);

    // the ciphertext rows are still there but permanently unreadable
    const [f] = await handle.db
      .select({ b: sql<Buffer>`${facts.body}` })
      .from(facts)
      .where(and(eq(facts.extractionRunId, extractionRunId), sql`${facts.body} is not null`));
    const [engRow] = await handle.db
      .select({ wrappedDek: engagements.wrappedDek, status: engagements.status })
      .from(engagements)
      .where(eq(engagements.id, engagementA));
    expect(engRow!.wrappedDek).toBeNull();
    expect(engRow!.status).toBe('shredded');
    // no DEK exists to build a cipher from; a fresh key cannot open the blob
    const strayCipher = new EngagementCipher(tenantA, engagementA, new Uint8Array(randomBytes(32)));
    await expect(strayCipher.decryptString('facts.body', f!.b as never)).rejects.toThrow();

    // the shred is on the tenant-visible audit log
    const logRows = await withTenant(handle.db, tenantA, (tx) =>
      tx
        .select({ action: accessLog.action, resourceId: accessLog.resourceId })
        .from(accessLog)
        .where(and(eq(accessLog.engagementId, engagementA), eq(accessLog.action, 'crypto_shred'))),
    );
    expect(logRows).toEqual([{ action: 'crypto_shred', resourceId: engagementA }]);
  }, 60_000);
});
