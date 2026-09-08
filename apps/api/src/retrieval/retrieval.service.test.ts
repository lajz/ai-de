import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementCipher } from '@fde/crypto';
import type { EmbeddingClient, Router } from '@fde/llm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '../request-context/request-context.js';
import { RetrievalService } from './retrieval.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;
const sourceId = randomUUID();

/** A drizzle-shaped chain that ignores every arg and resolves to the next queued rowset. */
function fakeDb(resultSets: unknown[][]) {
  const inserts: Record<string, unknown>[] = [];
  let i = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
    chain[m] = () => chain;
  }
  chain.then = (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
    Promise.resolve()
      .then(() => resultSets[i++] ?? [])
      .then(ok, err);
  const tx = {
    select: () => chain,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Promise.resolve();
      },
    }),
  };
  return { tx, inserts };
}

const decryptString = vi.fn(async (_path: string, ct: unknown) => `DEC(${String(ct)})`);
const cipher = { decryptString } as unknown as EngagementCipher;

const fakeEmbeddings: EmbeddingClient = {
  model: 'fake',
  dim: 3,
  embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};

function fakeRouter(text: string) {
  return {
    complete: vi.fn(async () => ({ text, usage: {} })),
  } as unknown as Router & { complete: ReturnType<typeof vi.fn> };
}

const config = (enforce: boolean) =>
  ({
    get: (k: string) => (k === 'AUTHZ_ENFORCE' ? String(enforce) : undefined),
  }) as unknown as ConfigService<Env, true>;

function run<T>(tx: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    { tenantId, userId, tx: tx as never, engagement: { id: engagementId, cipher } },
    fn,
  );
}

beforeEach(() => {
  decryptString.mockClear();
});

describe('RetrievalService.answerQuestion', () => {
  it('runs the authz gate BEFORE the LLM and before any decryption', async () => {
    const authz = new InMemoryAuthzClient(); // no role granted
    const router = fakeRouter('unused');
    const svc = new RetrievalService(authz, router, fakeEmbeddings, config(true));
    const { tx } = fakeDb([[{ sourceId, chunkRef: 'r:0' }]]);

    await expect(run(tx, () => svc.answerQuestion('what was decided?'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(router.complete).not.toHaveBeenCalled();
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('answers from decrypted post-gate context, cites permalinks, logs retrieval + content_read', async () => {
    const authz = new InMemoryAuthzClient();
    await authz.grantEngagementRole(userId, engagementId, 'viewer');
    const router = fakeRouter('We chose Postgres (https://ex.com/p/1)');
    const svc = new RetrievalService(authz, router, fakeEmbeddings, config(true));
    const { tx, inserts } = fakeDb([
      [{ sourceId, chunkRef: 'r:0' }],
      [
        {
          sourceId,
          permalink: 'https://ex.com/p/1',
          quote: 'ct-quote',
          factSummary: 'The team will use Postgres.',
          factBody: null,
        },
      ],
    ]);

    const res = await run(tx, () => svc.answerQuestion('  what db?  '));

    expect(router.complete).toHaveBeenCalledTimes(1);
    const arg = router.complete.mock.calls[0]![0] as { messages: { content: string }[] };
    expect(arg.messages[0]!.content).toContain('Question: what db?');
    expect(arg.messages[0]!.content).toContain('DEC(ct-quote)'); // decrypted, in-context
    expect(res.answer).toBe('We chose Postgres (https://ex.com/p/1)');
    expect(res.citations).toEqual([
      { sourceId, permalink: 'https://ex.com/p/1', quote: 'DEC(ct-quote)' },
    ]);
    expect(inserts.map((r) => r.action)).toEqual(['retrieval', 'content_read']);
    for (const row of inserts) expect(JSON.stringify(row)).not.toContain('DEC(');
  });

  it('logs retrieval + content_read even when the LLM call fails', async () => {
    const authz = new InMemoryAuthzClient();
    await authz.grantEngagementRole(userId, engagementId, 'viewer');
    const router = {
      complete: vi.fn(async () => {
        throw new Error('rate limited');
      }),
    } as unknown as Router;
    const svc = new RetrievalService(authz, router, fakeEmbeddings, config(true));
    const { tx, inserts } = fakeDb([[{ sourceId, chunkRef: 'r:0' }], []]);

    await expect(run(tx, () => svc.answerQuestion('q?'))).rejects.toThrow('rate limited');
    expect(inserts.map((r) => r.action)).toEqual(['retrieval', 'content_read']);
  });

  it('rejects an empty question and still calls the LLM on the no-candidate path', async () => {
    const svc = new RetrievalService(
      new InMemoryAuthzClient(),
      fakeRouter('x'),
      fakeEmbeddings,
      config(false),
    );
    await expect(run(fakeDb([]).tx, () => svc.answerQuestion('   '))).rejects.toThrow(/question/);

    const router = fakeRouter('That is not in the retrieved context.');
    const svc2 = new RetrievalService(
      new InMemoryAuthzClient(),
      router,
      fakeEmbeddings,
      config(false),
    );
    const res = await run(fakeDb([[]]).tx, () => svc2.answerQuestion('anything?'));
    expect(res).toEqual({ answer: 'That is not in the retrieved context.', citations: [] });
    expect(router.complete).toHaveBeenCalledTimes(1);
  });
});

describe('RetrievalService.listFacts', () => {
  it('returns facts with decrypted body + evidence citations and logs one content_read', async () => {
    const svc = new RetrievalService(
      new InMemoryAuthzClient(),
      fakeRouter('unused'),
      fakeEmbeddings,
      config(false),
    );
    const { tx, inserts } = fakeDb([
      [
        {
          id: 'f1',
          type: 'decision',
          summary: 's1',
          body: 'ct-b1',
          status: 'open',
          confidence: 0.9,
          occurredAt: null,
          createdAt: new Date('2026-02-02T00:00:00Z'),
        },
      ],
      [
        {
          factId: 'f1',
          sourceId,
          quote: 'ct-q1',
          charStart: 0,
          charEnd: 5,
          relation: 'supports',
          permalink: 'https://ex.com/p/9',
        },
      ],
    ]);

    const res = await run(tx, () => svc.listFacts());

    expect(res).toHaveLength(1);
    expect(res[0]!.body).toBe('DEC(ct-b1)');
    expect(res[0]!.citations[0]).toMatchObject({
      permalink: 'https://ex.com/p/9',
      quote: 'DEC(ct-q1)',
      charStart: 0,
      relation: 'supports',
    });
    expect(inserts.map((r) => r.action)).toEqual(['content_read']);
  });

  it('403s under enforce when the caller has no role', async () => {
    const svc = new RetrievalService(
      new InMemoryAuthzClient(),
      fakeRouter('unused'),
      fakeEmbeddings,
      config(true),
    );
    await expect(run(fakeDb([]).tx, () => svc.listFacts())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
