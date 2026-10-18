import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import type { EngagementCipher } from '@fde/crypto';
import { runWithRequestContext } from '@fde/request-context';
import { describe, expect, it } from 'vitest';

import type { Env } from '../config/env.js';
import { hashSecretHex } from '../auth/secret-hash.js';
import { CustomIntegrationSecretService } from './custom-integration-secret.service.js';
import { IntegrationsService } from './integrations.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;

const mapping = {
  artifact: { externalIdPath: 'id', kind: 'issue', occurredAtPath: 'at' },
  entities: [{ key: 'a', type: 'work_item', externalIdPath: 'id', displayNamePath: 'title' }],
  relationships: [],
};

/** Row-shaped fake: records every call; `.returning()` yields `returned`. */
function fakeTx(returned: unknown[] = []) {
  const calls: { op: string; arg?: unknown }[] = [];
  const chain = (op: string): Record<string, unknown> => {
    const c: Record<string, unknown> = {};
    for (const m of ['from', 'where', 'orderBy', 'limit', 'set']) {
      c[m] = (arg?: unknown) => {
        if (m === 'set') calls.push({ op: `${op}.set`, arg });
        return c;
      };
    }
    c.values = (arg: unknown) => {
      calls.push({ op: `${op}.values`, arg });
      return c;
    };
    c.returning = () => c;
    c.then = (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) =>
      Promise.resolve(returned).then(ok, err);
    return c;
  };
  const tx = {
    select: () => (calls.push({ op: 'select' }), chain('select')),
    insert: () => (calls.push({ op: 'insert' }), chain('insert')),
    update: () => (calls.push({ op: 'update' }), chain('update')),
    delete: () => (calls.push({ op: 'delete' }), chain('delete')),
  };
  return { tx, calls };
}

function row(over: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: randomUUID(),
    tenantId,
    engagementId,
    name: 'My int',
    enabled: true,
    mapping,
    secretHash: 'h',
    secretPrefix: 'fdeci_abcdefgh',
    secretSetAt: now,
    lastIngestedAt: null,
    createdByUserId: userId,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

const config = {
  get: (k: string) => (k === 'API_PUBLIC_URL' ? 'https://api.example.com/' : undefined),
} as unknown as ConfigService<Env, true>;

async function svc(admin = true) {
  const authz = new InMemoryAuthzClient();
  if (admin) await authz.grantTenantRole(userId, tenantId, 'admin');
  return new IntegrationsService(authz, new CustomIntegrationSecretService(), config);
}

function run<T>(tx: unknown, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext(
    {
      tenantId,
      userId,
      tx: tx as never,
      engagement: { id: engagementId, cipher: {} as EngagementCipher },
    },
    fn,
  );
}

describe('IntegrationsService', () => {
  it('create: stores only the hash, returns the secret once, builds the ingest URL', async () => {
    const { tx, calls } = fakeTx([row()]);
    const res = await run(tx, async () => (await svc()).create({ name: ' My int ', mapping }));
    const values = calls.find((c) => c.op === 'insert.values')!.arg as Record<string, unknown>;
    expect(res.secret.startsWith('fdeci_')).toBe(true);
    expect(values.secretHash).toBe(hashSecretHex(res.secret));
    expect(JSON.stringify(values)).not.toContain(res.secret);
    expect(values).toMatchObject({
      tenantId,
      engagementId,
      name: 'My int',
      createdByUserId: userId,
    });
    expect(res.ingestUrl).toBe(
      `https://api.example.com/engagements/${engagementId}/integrations/${res.id}/ingest`,
    );
    expect(res).not.toHaveProperty('secretHash');
  });

  it('create: 422 with issues on a bad mapping, and writes nothing', async () => {
    const { tx, calls } = fakeTx();
    const bad = { ...mapping, relationships: [{ from: 'a', predicate: 'relates_to', to: 'zzz' }] };
    await expect(
      run(tx, async () => (await svc()).create({ name: 'x', mapping: bad })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(calls.some((c) => c.op === 'insert')).toBe(false);
  });

  it('non-admins are refused on every operation, before touching the db', async () => {
    const { tx, calls } = fakeTx([row()]);
    const s = await svc(false);
    const id = randomUUID();
    for (const fn of [
      () => s.list(),
      () => s.get(id),
      () => s.create({ name: 'x', mapping }),
      () => s.update(id, { enabled: false }),
      () => s.remove(id),
      () => s.rotateSecret(id),
      () => s.test({ mapping, payload: {} }),
    ]) {
      await expect(run(tx, fn)).rejects.toBeInstanceOf(ForbiddenException);
    }
    expect(calls).toEqual([]);
  });

  it('update: partial patch; 404 when no row matches this engagement', async () => {
    const hit = fakeTx([row({ enabled: false })]);
    const res = await run(hit.tx, async () =>
      (await svc()).update(randomUUID(), { enabled: false }),
    );
    expect(res.enabled).toBe(false);
    expect(hit.calls.find((c) => c.op === 'update.set')!.arg as object).toMatchObject({
      enabled: false,
    });

    const miss = fakeTx([]);
    await expect(
      run(miss.tx, async () => (await svc()).update(randomUUID(), { name: 'n' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update: 422 on a bad mapping', async () => {
    const { tx } = fakeTx([row()]);
    await expect(
      run(tx, async () => (await svc()).update(randomUUID(), { mapping: { entities: [] } })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });

  it('remove: 404 when nothing deleted', async () => {
    await expect(
      run(fakeTx([]).tx, async () => (await svc()).remove(randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      run(fakeTx([{ id: 'x' }]).tx, async () => (await svc()).remove(randomUUID())),
    ).resolves.toBeUndefined();
  });

  it('rotateSecret: overwrites the hash and returns a new secret once', async () => {
    const { tx, calls } = fakeTx([row()]);
    const res = await run(tx, async () => (await svc()).rotateSecret(randomUUID()));
    const set = calls.find((c) => c.op === 'update.set')!.arg as Record<string, unknown>;
    expect(set.secretHash).toBe(hashSecretHex(res.secret));
    expect(set.secretPrefix).toBe(res.secret.slice(0, 14));
  });

  it('test: dry-run never touches the db and reports issues for a partly-wrong payload', async () => {
    const { tx, calls } = fakeTx();
    const res = await run(tx, async () =>
      (await svc()).test({ mapping, payload: { id: 7, title: 'T' } }),
    );
    expect(calls).toEqual([]);
    expect(res.issues).toEqual([]);
    expect(res.records).toHaveLength(1);

    const partial = await run(tx, async () => (await svc()).test({ mapping, payload: { id: 7 } }));
    expect(partial.records).toEqual([]);
    expect(partial.issues[0]?.at).toBe('entities[0].displayNamePath');
    expect(calls).toEqual([]);
  });

  it('test: 422 on an invalid draft mapping', async () => {
    await expect(
      run(fakeTx().tx, async () => (await svc()).test({ mapping: {}, payload: {} })),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
  });
});
