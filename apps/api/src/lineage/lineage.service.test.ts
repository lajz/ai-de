import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementCipher } from '@fde/crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '../request-context/request-context.js';
import { GRAPH_EDGE_CAP, LineageService } from './lineage.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;

/** drizzle-shaped fake: each `.select()` consumes the next queued rowset; inserts are recorded. */
function fakeTx(selectResults: unknown[][]) {
  const inserts: Record<string, unknown>[] = [];
  let i = 0;
  const chain = (rows: unknown[]): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'innerJoin', 'leftJoin', 'groupBy']) {
      c[m] = () => c;
    }
    c.then = (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(rows).then(ok, err);
    return c;
  };
  return {
    tx: {
      select: () => chain(selectResults[i++] ?? []),
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserts.push(v);
          return Promise.resolve();
        },
      }),
    },
    inserts,
  };
}

const bytes = (s: string) => new TextEncoder().encode(s);
const decryptString = vi.fn(
  async (_p: string, ct: unknown) => `DEC(${new TextDecoder().decode(ct as Uint8Array)})`,
);
const decryptJson = vi.fn(async (_p: string, _ct: unknown) => [
  { scope: 'granola_workspace', resourceId: 'w1', principals: ['u1', 'u2'], public: false },
]);
const cipher = { decryptString, decryptJson } as unknown as EngagementCipher;

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

const svc = () => new LineageService(new InMemoryAuthzClient(), config(false));

beforeEach(() => vi.clearAllMocks());

describe('LineageService.getFactProvenance', () => {
  const factId = randomUUID();

  it('assembles the chain and decrypts quote / body / acl post-gate, logging one content_read', async () => {
    const { tx, inserts } = fakeTx([
      [
        {
          id: factId,
          type: 'decision',
          summary: 'chose Postgres',
          body: bytes('ct-body'),
          status: 'open',
          confidence: 0.9,
          occurredAt: null,
          createdAt: new Date('2026-02-02T00:00:00Z'),
          extractionRunId: 'run-1',
        },
      ],
      [
        {
          evidenceId: 'e1',
          quote: bytes('ct-quote'),
          charStart: 0,
          charEnd: 5,
          relation: 'supports',
          sourceId: 's1',
          connector: 'granola',
          externalId: 'ext-1',
          kind: 'transcript',
          urlPermalink: 'https://ex.com/p/1',
          occurredAt: new Date('2026-01-01T00:00:00Z'),
          aclPrincipalRules: bytes('ct-acl'),
          aclCapturedAt: new Date('2026-01-01T00:00:00Z'),
          aclTtlSeconds: 3600,
        },
      ],
      [
        {
          id: 'run-1',
          model: 'claude-opus-5',
          promptVersion: 'v3',
          costUsd: 0.02,
          inputSourceIds: ['s1'],
          createdAt: new Date('2026-02-01T00:00:00Z'),
        },
      ],
    ]);

    const res = await run(tx, () => svc().getFactProvenance(factId));

    expect(res.fact.body).toBe('DEC(ct-body)');
    expect(res.evidence[0]).toMatchObject({
      quote: 'DEC(ct-quote)',
      relation: 'supports',
      source: { connector: 'granola', kind: 'transcript', urlPermalink: 'https://ex.com/p/1' },
      acl: { ruleCount: 1, principalKinds: ['granola_workspace'], ttlSeconds: 3600 },
    });
    expect(res.extractionRun).toEqual({
      model: 'claude-opus-5',
      promptVersion: 'v3',
      costUsd: 0.02,
      createdAt: '2026-02-01T00:00:00.000Z',
    });
    expect(inserts.map((r) => r.action)).toEqual(['content_read']);
    for (const row of inserts) expect(JSON.stringify(row)).not.toContain('DEC(');
  });

  it('404s when the fact is not in the engagement', async () => {
    await expect(
      run(fakeTx([[]]).tx, () => svc().getFactProvenance(factId)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('LineageService.getGraph', () => {
  it('returns cleartext entity + fact nodes and never decrypts', async () => {
    const { tx } = fakeTx([
      [
        {
          id: 'n1',
          type: 'person',
          displayName: 'Jane',
          externalRefs: [{ connector: 'granola', externalId: 'u1' }],
        },
      ],
      [{ id: 'f1', type: 'decision', summary: 'chose PG', status: 'open' }],
      [
        {
          id: 'r1',
          fromKind: 'entity',
          fromId: 'n1',
          predicate: 'owns',
          toKind: 'fact',
          toId: 'f1',
          sourceId: 's1',
        },
      ],
    ]);
    const g = await run(tx, () => svc().getGraph({}));
    expect(g.nodes).toEqual([
      {
        id: 'n1',
        kind: 'entity',
        type: 'person',
        label: 'Jane',
        externalRefs: [{ connector: 'granola', externalId: 'u1' }],
      },
      { id: 'f1', kind: 'fact', type: 'decision', label: 'chose PG', status: 'open' },
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.truncated).toBe(false);
    expect(decryptString).not.toHaveBeenCalled();
  });

  it('flags truncated when the edge cap is exceeded', async () => {
    const edges = Array.from({ length: GRAPH_EDGE_CAP + 1 }, (_, k) => ({
      id: `r${k}`,
      fromKind: 'entity',
      fromId: 'n1',
      predicate: 'relates_to',
      toKind: 'entity',
      toId: 'n2',
      sourceId: null,
    }));
    const { tx } = fakeTx([[], [], edges]);
    const g = await run(tx, () => svc().getGraph({}));
    expect(g.edges).toHaveLength(GRAPH_EDGE_CAP);
    expect(g.truncated).toBe(true);
  });

  it('drops fact nodes when ?entityType filters the entities', async () => {
    const { tx } = fakeTx([
      [{ id: 'n1', type: 'person', displayName: 'Jane', externalRefs: [] }],
      [
        {
          id: 'r1',
          fromKind: 'entity',
          fromId: 'n1',
          predicate: 'owns',
          toKind: 'fact',
          toId: 'f1',
          sourceId: null,
        },
      ],
    ]);
    const g = await run(tx, () => svc().getGraph({ entityType: 'person' }));
    expect(g.nodes.every((n) => n.kind === 'entity')).toBe(true);
  });

  it('400s on an unknown ?entityType or ?predicate', async () => {
    await expect(
      run(fakeTx([]).tx, () => svc().getGraph({ entityType: 'nope' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      run(fakeTx([]).tx, () => svc().getGraph({ predicate: 'nope' })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('LineageService.getPipeline', () => {
  it('returns metadata-only sync state + runs + rollups', async () => {
    const { tx } = fakeTx([
      [
        {
          connector: 'granola',
          status: 'idle',
          cursor: 'c1',
          lastRunAt: new Date('2026-03-01T00:00:00Z'),
          updatedAt: new Date('2026-03-02T00:00:00Z'),
        },
      ],
      [
        {
          id: 'run-1',
          model: 'claude-sonnet-5',
          promptVersion: 'v3',
          costUsd: 0.01,
          inputSourceIds: ['s1', 's2'],
          createdAt: new Date('2026-03-01T00:00:00Z'),
        },
      ],
      [{ value: 12 }],
      [{ value: 40 }],
      [{ connector: 'granola', value: 3 }],
      [{ value: '0.05' }],
    ]);
    const p = await run(tx, () => svc().getPipeline());
    expect(p.syncStates[0]).toEqual({
      connector: 'granola',
      status: 'idle',
      lastRunAt: '2026-03-01T00:00:00.000Z',
      cursorPresent: true,
      updatedAt: '2026-03-02T00:00:00.000Z',
    });
    expect(p.recentExtractionRuns[0]).toEqual({
      model: 'claude-sonnet-5',
      promptVersion: 'v3',
      costUsd: 0.01,
      inputSourceCount: 2,
      createdAt: '2026-03-01T00:00:00.000Z',
    });
    expect(p.rollups).toEqual({
      totalFacts: 12,
      totalEmbeddings: 40,
      totalCostUsd: 0.05,
      sourcesByConnector: { granola: 3 },
    });
    expect(decryptString).not.toHaveBeenCalled();
    expect(decryptJson).not.toHaveBeenCalled();
  });
});
