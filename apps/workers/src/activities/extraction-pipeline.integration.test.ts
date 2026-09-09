import { randomUUID } from 'node:crypto';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  captureSessions,
  createDbClient,
  embeddings,
  engagements,
  evidence,
  extractionRuns,
  facts,
  shredEngagement,
  sources,
  tenants,
  withEngagement,
  withTenant,
  type Database,
} from '@fde/db';
import {
  EMBEDDING_DIM,
  EXTRACTION_PROMPT_VERSION,
  FakeEmbeddingClient,
  FakeTracer,
  type ExtractionResult,
  type Router,
} from '@fde/llm';
import { ApplicationFailure } from '@temporalio/common';
import { MockActivityEnvironment } from '@temporalio/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createExtractionActivities } from './extraction-pipeline.js';

// Integration test — needs a migrated + hardened database (see
// packages/db/src/engagement.test.ts). Skipped unless DATABASE_URL is set.
const url = process.env.DATABASE_URL;

const TRANSCRIPT =
  "Alice Rivera: Welcome. We decided to ship on Friday.\nBob Chen: I'll send the SOW by Thursday.";
const DECISION_QUOTE = 'We decided to ship on Friday.';
const COMMITMENT_QUOTE = "I'll send the SOW by Thursday.";

/** `Router` double — returns a fixed `ExtractionResult`, no network, no schema check. */
function fakeRouter(canned: ExtractionResult, costUsd: number): Router {
  const stub = () => {
    throw new Error('fakeRouter: unused');
  };
  return {
    provider: { name: 'fake', zeroDataRetention: true, modelForTier: () => 'claude-sonnet-5' },
    zeroDataRetention: true,
    assertZeroDataRetention() {},
    complete: stub,
    async extract() {
      return { value: canned, usage: { costUsd } };
    },
  } as unknown as Router;
}

/** One locatable decision (with detail) + one commitment whose span is deliberately wrong. */
function cannedResult(): ExtractionResult {
  const dStart = TRANSCRIPT.indexOf(DECISION_QUOTE);
  return {
    facts: [
      {
        type: 'decision',
        summary: 'Ship on Friday',
        detail: 'The team settled on a Friday ship date.',
        confidence: 0.9,
        evidence: [
          {
            quote: DECISION_QUOTE,
            charStart: dStart,
            charEnd: dStart + DECISION_QUOTE.length,
            relation: 'supports',
          },
        ],
      },
      {
        type: 'commitment',
        summary: 'Bob sends the SOW',
        confidence: 0.8,
        evidence: [{ quote: COMMITMENT_QUOTE, charStart: 0, charEnd: 5, relation: 'supports' }],
      },
    ],
  } as ExtractionResult;
}

describe.skipIf(!url)('runExtractionActivity (integration)', () => {
  const provider = new FakeKeyProvider();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  async function seed(retentionPolicy: RetentionPolicy, body: string | null) {
    const engagementId = randomUUID() as EngagementId;
    const sourceId = randomUUID();
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
    await withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      await tx.insert(sources).values({
        id: sourceId,
        tenantId,
        engagementId,
        connector: 'recall',
        externalId: `bot-${sourceId.slice(0, 8)}`,
        kind: 'transcript',
        urlPermalink: 'https://meet.example/x',
        occurredAt: new Date('2026-09-07T15:00:00.000Z'),
        contentHash: sourceId,
        rawBody: body == null ? null : await getCipher().encryptString('sources.raw_body', body),
        retentionPolicy,
      });
    });
    return { engagementId, sourceId };
  }

  let tracer: FakeTracer;
  const acts = (costUsd = 0.0009) => {
    tracer = new FakeTracer();
    return createExtractionActivities({
      db: handle.db,
      keyProvider: provider,
      router: fakeRouter(cannedResult(), costUsd),
      embeddingClient: new FakeEmbeddingClient(),
      tracer,
    });
  };

  const run = <T>(fn: (i: never) => Promise<T>, i: unknown): Promise<T> =>
    new MockActivityEnvironment().run(fn as never, i as never) as Promise<T>;

  beforeAll(async () => {
    handle = createDbClient({ url: url!, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.close();
  });

  it('writes encrypted facts + evidence + embeddings, stamps the run, resolves spans, is retry-idempotent', async () => {
    const { engagementId, sourceId } = await seed('full-retention', TRANSCRIPT);
    const extractionRunId = randomUUID();
    const input = { tenantId, engagementId, sourceId, extractionRunId };

    const result = await run(acts().runExtractionActivity, input);
    await run(acts().runExtractionActivity, input); // retry: same id → redo, no dupes

    expect(result).toMatchObject({
      retentionPolicy: 'full-retention',
      purgeRawAfter: null,
      factCount: 2,
      chunkCount: 1,
      embeddingCount: 1,
      modelCallCount: 1,
      unlocatableSpanCount: 1,
      usdCost: 0.0009,
    });

    // one redacted trace: a per-chunk generation + a run-end tally, no content
    expect(tracer.traces).toHaveLength(1);
    expect(tracer.traces[0]!.input).toMatchObject({ name: 'extraction.run', extractionRunId });
    expect(tracer.traces[0]!.generations).toMatchObject([
      { name: 'extraction.chunk', outcome: 'ok' },
    ]);
    expect(tracer.traces[0]!.end).toMatchObject({ factCount: 2, chunkCount: 1, okChunks: 1 });
    expect(JSON.stringify(tracer.traces)).not.toMatch(/Friday|SOW|Rivera|Chen/);

    // ciphertext at rest — raw column reads never expose the plaintext
    const [rawBody] = await handle.db
      .select({ b: sql<Buffer>`${facts.body}` })
      .from(facts)
      .where(sql`${facts.extractionRunId} = ${extractionRunId} and ${facts.body} is not null`);
    expect(rawBody!.b.toString('utf8')).not.toMatch(/Friday|SOW/);

    // decrypts through withEngagement; spans point at the source; the run is stamped
    const seen = await withEngagement(
      handle.db,
      provider,
      { tenantId, engagementId },
      async (tx) => {
        const f = await tx
          .select({ id: facts.id, type: facts.type, body: facts.body })
          .from(facts)
          .where(eq(facts.extractionRunId, extractionRunId));
        const e = await tx
          .select({
            factId: evidence.factId,
            quote: evidence.quote,
            cs: evidence.charStart,
            ce: evidence.charEnd,
          })
          .from(evidence)
          .where(eq(evidence.extractionRunId, extractionRunId));
        const emb = await tx.select().from(embeddings).where(eq(embeddings.sourceId, sourceId));
        const [runRow] = await tx
          .select()
          .from(extractionRuns)
          .where(eq(extractionRuns.id, extractionRunId));
        const decision = f.find((x) => x.type === 'decision')!;
        return {
          decisionBody: await getCipher().decryptString('facts.body', decision.body!),
          decisionEv: e.find((x) => x.factId === decision.id)!,
          commitmentEv: e.find((x) => x.factId !== decision.id)!,
          decisionQuote: await getCipher().decryptString(
            'evidence.quote',
            e.find((x) => x.factId === decision.id)!.quote!,
          ),
          factCount: f.length,
          emb,
          runRow,
        };
      },
    );

    expect(seen.factCount).toBe(2); // idempotent — not 4
    expect(seen.decisionBody).toBe('The team settled on a Friday ship date.');
    expect(seen.decisionQuote).toBe(DECISION_QUOTE);
    expect(TRANSCRIPT.slice(seen.decisionEv.cs!, seen.decisionEv.ce!)).toBe(DECISION_QUOTE);
    expect([seen.commitmentEv.cs, seen.commitmentEv.ce]).toEqual([null, null]); // unlocatable → null
    expect(seen.emb).toHaveLength(1);
    expect(seen.emb[0]!.embedding).toHaveLength(EMBEDDING_DIM);
    expect(seen.emb[0]!.model).toBe('fake-deterministic');
    expect(seen.runRow).toMatchObject({
      model: 'claude-sonnet-5',
      promptVersion: EXTRACTION_PROMPT_VERSION,
      inputSourceIds: [sourceId],
      costUsd: 0.0009,
    });
  });

  it('reference-only (no retained body) → non-retryable ApplicationFailure', async () => {
    const { engagementId, sourceId } = await seed('reference-only', null);
    const err = await run(acts().runExtractionActivity, {
      tenantId,
      engagementId,
      sourceId,
      extractionRunId: randomUUID(),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApplicationFailure);
    expect((err as ApplicationFailure).type).toBe('NoRetainedBody');
    expect((err as ApplicationFailure).nonRetryable).toBe(true);
    // the trace is still closed on the error path (no run tally)
    expect(tracer.traces[0]!.ended).toBe(true);
    expect(tracer.traces[0]!.end).toBeUndefined();
  });

  it('derived-ephemeral-raw: returns the capture purge marker, then purgeRawBodyActivity nulls the body', async () => {
    const { engagementId, sourceId } = await seed('derived-ephemeral-raw', TRANSCRIPT);
    const purgeAt = new Date(Date.now() - 60_000); // already elapsed
    await withTenant(handle.db, tenantId, (tx) =>
      tx.insert(captureSessions).values({
        id: randomUUID(),
        tenantId,
        engagementId,
        meetingUrl: 'https://meet.example/x',
        joinAt: new Date('2026-09-07T15:00:00.000Z'),
        status: 'captured',
        sourceId,
        purgeRawAfter: purgeAt,
        retentionPolicy: 'derived-ephemeral-raw',
      }),
    );
    const extractionRunId = randomUUID();
    const a = acts();
    const ids = { tenantId, engagementId, sourceId, extractionRunId };

    const result = await run(a.runExtractionActivity, ids);
    expect(new Date(result.purgeRawAfter!).getTime()).toBe(purgeAt.getTime());

    // an unknown / incomplete run never purges — the raw body is the only copy
    expect(await run(a.purgeRawBodyActivity, { ...ids, extractionRunId: randomUUID() })).toEqual({
      purged: false,
    });

    expect(await run(a.purgeRawBodyActivity, ids)).toEqual({ purged: true });
    const [row] = await handle.db
      .select({ rawBody: sources.rawBody })
      .from(sources)
      .where(eq(sources.id, sourceId));
    expect(row!.rawBody).toBeNull();

    // once the engagement is crypto-shredded the body is unreadable anyway —
    // purge is a clean no-op, never a workflow failure
    await shredEngagement(handle.db, {
      tenantId,
      engagementId,
      actorId: 'admin-1',
      reason: 'test',
    });
    expect(await run(a.purgeRawBodyActivity, ids)).toEqual({ purged: false });
  });
});
