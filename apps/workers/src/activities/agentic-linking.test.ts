import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId } from '@fde/core';
import { FakeKeyProvider, getCipher } from '@fde/crypto';
import {
  createDbClient,
  embeddings,
  engagements,
  entities,
  evidence,
  facts,
  relationships,
  sources,
  tenants,
  withEngagement,
  type Database,
} from '@fde/db';
import { FakeEmbeddingClient, FakeTracer, type AgenticLinkingResult, type Router } from '@fde/llm';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENTIC_LINKING_CONFIDENCE_THRESHOLD,
  createAgenticLinkingActivities,
  extractTicketKeys,
} from './agentic-linking.js';

describe('extractTicketKeys', () => {
  it('extracts nothing from empty text or plain prose', () => {
    expect(extractTicketKeys('')).toEqual([]);
    expect(extractTicketKeys('Fix the login button on the homepage.')).toEqual([]);
  });

  it('extracts a Linear/Jira-style ticket key', () => {
    expect(extractTicketKeys('Fixes ENG-42 for real this time')).toEqual(['ENG-42']);
    expect(
      new Set(extractTicketKeys('Relates to ENG-42 and also ABC-7, plus ENG-42 again')),
    ).toEqual(new Set(['ENG-42', 'ABC-7']));
  });

  it('extracts a GitHub-style owner/repo#number reference', () => {
    expect(extractTicketKeys('See acme/widgets#123 for context')).toEqual(['acme/widgets#123']);
  });

  it('does not extract a bare "#123" (no repo qualifier) or a lowercase key', () => {
    expect(extractTicketKeys('closes #123')).toEqual([]);
    expect(extractTicketKeys('see eng-42')).toEqual([]);
  });

  it('is bounded — never throws on a very long body', () => {
    const long = `${'x'.repeat(1_000_000)} ENG-99`;
    expect(() => extractTicketKeys(long)).not.toThrow();
  });
});

describe.skipIf(!process.env.DATABASE_URL)('runAgenticLinkingActivity (integration)', () => {
  const url = process.env.DATABASE_URL!;
  const provider = new FakeKeyProvider();
  const embeddingClient = new FakeEmbeddingClient();
  let handle: { db: Database; close: () => Promise<void> };
  const tenantId = randomUUID() as TenantId;

  /** `Router` double that returns a fixed set of judgments, no schema check. */
  function fakeJudgmentRouter(judgments: AgenticLinkingResult['judgments']): Router {
    const stub = () => {
      throw new Error('fakeJudgmentRouter: unused');
    };
    return {
      provider: { name: 'fake', zeroDataRetention: true, modelForTier: () => 'claude-sonnet-5' },
      zeroDataRetention: true,
      assertZeroDataRetention() {},
      complete: stub,
      async extract() {
        return { value: { judgments }, usage: { costUsd: 0.0001 } };
      },
    } as unknown as Router;
  }

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

  /** A bare `sources` row — evidence/embeddings both FK onto it. */
  async function seedSource(engagementId: EngagementId, connector: string): Promise<string> {
    const id = randomUUID();
    await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx.insert(sources).values({
        id,
        tenantId,
        engagementId,
        connector,
        externalId: `ext-${id.slice(0, 8)}`,
        kind: connector === 'recall' ? 'transcript' : 'issue',
        occurredAt: new Date('2026-09-19T00:00:00.000Z'),
        contentHash: id,
        retentionPolicy: 'full-retention',
      }),
    );
    return id;
  }

  /** The work item entity `runAgenticLinkingActivity` is triggered for. */
  async function seedWorkItem(
    engagementId: EngagementId,
    sourceId: string,
    title: string,
    body: string,
  ): Promise<string> {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const cipher = getCipher();
      const [row] = await tx
        .insert(entities)
        .values({
          tenantId,
          engagementId,
          type: 'work_item',
          displayName: title,
          externalRefs: [{ connector: 'github', externalId: `wi-${sourceId.slice(0, 8)}` }],
          attributes: await cipher.encryptJson('entities.attributes', {}),
          body: await cipher.encryptString('entities.body', body),
        })
        .returning({ id: entities.id });
      return row!.id;
    });
  }

  /** A `work_item` with a real `identifier` attribute, for the identifier-match signal. */
  async function seedWorkItemWithIdentifier(
    engagementId: EngagementId,
    identifier: string,
  ): Promise<string> {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const cipher = getCipher();
      const [row] = await tx
        .insert(entities)
        .values({
          tenantId,
          engagementId,
          type: 'work_item',
          displayName: identifier,
          externalRefs: [{ connector: 'linear', externalId: randomUUID() }],
          attributes: await cipher.encryptJson('entities.attributes', { identifier }),
          body: null,
        })
        .returning({ id: entities.id });
      return row!.id;
    });
  }

  /** A `decision` fact + one `evidence` row attesting it from `sourceId`. */
  async function seedFact(
    engagementId: EngagementId,
    sourceId: string,
    summary: string,
  ): Promise<string> {
    return withEngagement(handle.db, provider, { tenantId, engagementId }, async (tx) => {
      const [fact] = await tx
        .insert(facts)
        .values({ tenantId, engagementId, type: 'decision', summary })
        .returning({ id: facts.id });
      await tx.insert(evidence).values({
        tenantId,
        engagementId,
        factId: fact!.id,
        sourceId,
      });
      return fact!.id;
    });
  }

  /** One embedded chunk for `sourceId` — `selectNearestChunks` has no similarity floor, so any row in the engagement is "nearest". */
  async function seedEmbedding(engagementId: EngagementId, sourceId: string): Promise<void> {
    const [vector] = await embeddingClient.embed(['arbitrary chunk text']);
    await withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx.insert(embeddings).values({
        tenantId,
        engagementId,
        sourceId,
        chunkRef: `${sourceId}:0`,
        model: embeddingClient.model,
        embedding: vector!,
      }),
    );
  }

  const edgesOf = (engagementId: EngagementId) =>
    withEngagement(handle.db, provider, { tenantId, engagementId }, (tx) =>
      tx.select().from(relationships).where(eq(relationships.engagementId, engagementId)),
    );

  beforeAll(async () => {
    handle = createDbClient({ url, max: 1 });
    await handle.db.insert(tenants).values({ id: tenantId, name: 'T', cmkKeyRef: 'fake:cmk' });
  });
  afterAll(async () => {
    await handle.db.delete(engagements).where(eq(engagements.tenantId, tenantId));
    await handle.db.delete(tenants).where(eq(tenants.id, tenantId));
    await handle.close();
  });

  it('an identifier reference in the body auto-writes a relates_to edge, no LLM call needed', async () => {
    const engagementId = await seedEngagement();
    const targetId = await seedWorkItemWithIdentifier(engagementId, 'ENG-42');
    const workItemSourceId = await seedSource(engagementId, 'github');
    const workItemId = await seedWorkItem(
      engagementId,
      workItemSourceId,
      'Implements the fix',
      'Fixes ENG-42 for real this time.',
    );

    const acts = createAgenticLinkingActivities({
      db: handle.db,
      keyProvider: provider,
      router: fakeJudgmentRouter([]),
      embeddingClient,
      tracer: new FakeTracer(),
    });
    const result = await acts.runAgenticLinkingActivity({
      tenantId,
      engagementId,
      workItemEntityId: workItemId,
      sourceId: workItemSourceId,
    });

    expect(result.identifierMatches).toBe(1);
    const edges = await edgesOf(engagementId);
    expect(edges).toEqual([
      expect.objectContaining({
        fromKind: 'entity',
        fromId: workItemId,
        predicate: 'relates_to',
        toKind: 'entity',
        toId: targetId,
        sourceId: workItemSourceId,
        confidence: null,
      }),
    ]);
  });

  it('the LLM judgment step writes an edge only at/above the confidence threshold', async () => {
    const engagementId = await seedEngagement();
    const factSourceId = await seedSource(engagementId, 'recall');
    await seedEmbedding(engagementId, factSourceId);
    const belowFactId = await seedFact(engagementId, factSourceId, 'A decision worth nothing');
    const aboveFactId = await seedFact(engagementId, factSourceId, 'The decision that matters');

    const workItemSourceId = await seedSource(engagementId, 'github');
    const workItemId = await seedWorkItem(
      engagementId,
      workItemSourceId,
      'Ship the thing',
      'no ticket key in here',
    );

    const acts = createAgenticLinkingActivities({
      db: handle.db,
      keyProvider: provider,
      router: fakeJudgmentRouter([
        {
          candidateId: belowFactId,
          relates: true,
          confidence: AGENTIC_LINKING_CONFIDENCE_THRESHOLD - 0.1,
        },
        {
          candidateId: aboveFactId,
          relates: true,
          confidence: AGENTIC_LINKING_CONFIDENCE_THRESHOLD,
        },
      ]),
      embeddingClient,
      tracer: new FakeTracer(),
    });
    const result = await acts.runAgenticLinkingActivity({
      tenantId,
      engagementId,
      workItemEntityId: workItemId,
      sourceId: workItemSourceId,
    });

    expect(result.identifierMatches).toBe(0);
    expect(result.semanticCandidates).toBe(2);
    const edges = await edgesOf(engagementId);
    expect(edges).toEqual([
      expect.objectContaining({
        fromKind: 'entity',
        fromId: workItemId,
        predicate: 'relates_to',
        toKind: 'fact',
        toId: aboveFactId,
        sourceId: workItemSourceId,
        confidence: AGENTIC_LINKING_CONFIDENCE_THRESHOLD,
      }),
    ]);
  });

  it('relates: false is never written even at high confidence', async () => {
    const engagementId = await seedEngagement();
    const factSourceId = await seedSource(engagementId, 'recall');
    await seedEmbedding(engagementId, factSourceId);
    const factId = await seedFact(engagementId, factSourceId, 'An unrelated decision');

    const workItemSourceId = await seedSource(engagementId, 'github');
    const workItemId = await seedWorkItem(engagementId, workItemSourceId, 'Ship the thing', '');

    const acts = createAgenticLinkingActivities({
      db: handle.db,
      keyProvider: provider,
      router: fakeJudgmentRouter([{ candidateId: factId, relates: false, confidence: 0.99 }]),
      embeddingClient,
      tracer: new FakeTracer(),
    });
    await acts.runAgenticLinkingActivity({
      tenantId,
      engagementId,
      workItemEntityId: workItemId,
      sourceId: workItemSourceId,
    });

    expect(await edgesOf(engagementId)).toHaveLength(0);
  });
});
