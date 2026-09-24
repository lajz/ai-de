import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementCipher, KeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';
import type { EmbeddingClient, Router } from '@fde/llm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '@fde/request-context';
import type { AgenticQaService } from '../retrieval/agentic-qa.service.js';
import { RetrievalService } from '../retrieval/retrieval.service.js';
import type { TemporalCryptoShred } from '../temporal/temporal.module.js';
import { EngagementsController } from './engagements.controller.js';

const agenticQa = {} as AgenticQaService;
const db = {} as Database;
const temporalCryptoShred = {} as TemporalCryptoShred;
const keyProvider = {} as KeyProvider;

/**
 * Controller-level coverage for `GET :id/facts`'s query-param parsing —
 * mirrors `engagements.authz.test.ts`'s `audit()` coverage, but that suite
 * stubs `RetrievalService` out entirely, so pagination needs a real one here
 * (same `fakeDb` shape as `retrieval.service.test.ts`).
 */

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;

/** A drizzle-shaped chain that ignores every arg and resolves to the next queued rowset. */
function fakeDb(resultSets: unknown[][]) {
  let i = 0;
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin']) {
    chain[m] = () => chain;
  }
  chain.then = (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
    Promise.resolve()
      .then(() => resultSets[i++] ?? [])
      .then(ok, err);
  return {
    select: () => chain,
    insert: () => ({ values: () => Promise.resolve() }),
  };
}

const decryptString = vi.fn(async (_path: string, ct: unknown) => `DEC(${String(ct)})`);
const cipher = { decryptString } as unknown as EngagementCipher;
const engagement = { id: engagementId, cipher };

const fakeEmbeddings: EmbeddingClient = {
  model: 'fake',
  dim: 3,
  embed: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
};
const fakeRouter = { complete: vi.fn() } as unknown as Router;

const config = (enforce: boolean) =>
  ({
    get: (k: string) => (k === 'AUTHZ_ENFORCE' ? String(enforce) : undefined),
  }) as unknown as ConfigService<Env, true>;

function run<T>(tx: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ tenantId, userId, tx: tx as never, engagement }, fn);
}

function fact(id: string, createdAt: Date) {
  return {
    id,
    type: 'decision',
    summary: `summary ${id}`,
    body: null,
    status: 'open',
    confidence: null,
    occurredAt: null,
    createdAt,
  };
}

function controller(): EngagementsController {
  const authz = new InMemoryAuthzClient();
  const retrieval = new RetrievalService(authz, fakeRouter, fakeEmbeddings, config(false));
  return new EngagementsController(
    authz,
    retrieval,
    agenticQa,
    db,
    temporalCryptoShred,
    keyProvider,
    config(false),
  );
}

beforeEach(() => vi.clearAllMocks());

describe('EngagementsController.facts', () => {
  it('400s on a non-numeric limit', async () => {
    await expect(
      run(fakeDb([]), () => controller().facts(engagementId, 'not-a-number')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s on a malformed cursor', async () => {
    await expect(
      run(fakeDb([]), () => controller().facts(engagementId, undefined, 'not-a-cursor')),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('walks two pages with no duplicates and no gaps', async () => {
    // 3 rows queued for a limit=2 request — the "+1" overfetch that signals a next page.
    const rows = [
      fact('f3', new Date('2026-01-03T00:00:00Z')),
      fact('f2', new Date('2026-01-02T00:00:00Z')),
      fact('f1', new Date('2026-01-01T00:00:00Z')),
    ];
    const ctl = controller();

    const page1 = await run(fakeDb([rows, []]), () => ctl.facts(engagementId, '2', undefined));
    expect(page1.rows.map((r) => r.id)).toEqual(['f3', 'f2']);
    expect(page1.nextCursor).toBeDefined();

    // second page: only the remaining row is queued — no next cursor.
    const page2 = await run(fakeDb([[rows[2]], []]), () =>
      ctl.facts(engagementId, '2', page1.nextCursor),
    );
    expect(page2.rows.map((r) => r.id)).toEqual(['f1']);
    expect(page2.nextCursor).toBeUndefined();

    const seen = [...page1.rows, ...page2.rows].map((r) => r.id);
    expect(seen).toEqual(['f3', 'f2', 'f1']);
    expect(new Set(seen).size).toBe(3);
  });
});
