import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { InMemoryAuthzClient } from '@fde/authz';
import type { EngagementCipher } from '@fde/crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../config/env.js';
import { runWithRequestContext } from '../request-context/request-context.js';
import { EngagementsController } from './engagements.controller.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementA = randomUUID() as EngagementId;
const engagementB = randomUUID() as EngagementId;

/** drizzle-query-builder-shaped thenable that ignores every arg and resolves to `rows`. */
interface Chain {
  select: () => Chain;
  from: () => Chain;
  where: () => Chain;
  orderBy: () => Chain;
  limit: () => Chain;
  then: <R>(ok: (v: unknown[]) => R, err?: (e: unknown) => R) => Promise<R>;
}
function chain(rows: unknown[]): Chain {
  const c: Chain = {
    select: () => c,
    from: () => c,
    where: () => c,
    orderBy: () => c,
    limit: () => c,
    then: (ok, err) => Promise.resolve(rows).then(ok, err),
  };
  return c;
}
function fakeTx(rows: unknown[]) {
  return {
    select: () => chain(rows),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
}

const config = (enforce: boolean) =>
  ({
    get: (key: string) => (key === 'AUTHZ_ENFORCE' ? String(enforce) : undefined),
  }) as unknown as ConfigService<Env, true>;

const engagement = { id: engagementA, cipher: {} as unknown as EngagementCipher };

function run<T>(tx: unknown, eng: typeof engagement | undefined, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ tenantId, userId, tx: tx as never, engagement: eng }, fn);
}

const engagementRow = (id: EngagementId) => ({
  id,
  endCustomerName: 'Acme',
  regionPin: 'us',
  retentionPolicy: 'full-retention',
  status: 'active',
  createdAt: new Date(),
});

describe('EngagementsController — AUTHZ_ENFORCE on', () => {
  let authz: InMemoryAuthzClient;
  let controller: EngagementsController;

  beforeEach(() => {
    authz = new InMemoryAuthzClient();
    controller = new EngagementsController(authz, config(true));
  });

  it('GET :id/audit → 200 when the caller is seeded as a viewer', async () => {
    await authz.grantEngagementRole(userId, engagementA, 'viewer');
    const auditRows = [{ id: 'log1', action: 'content_read', createdAt: new Date() }];
    const res = await run(fakeTx(auditRows), engagement, () => controller.audit(engagementA));
    expect(res.rows).toHaveLength(1);
  });

  it('GET :id/audit → 403 when the caller has no role on the engagement', async () => {
    await expect(
      run(fakeTx([]), engagement, () => controller.audit(engagementA)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('POST :id/members lets a tenant admin grant a role; the grantee can then view', async () => {
    await authz.grantTenantRole(userId, tenantId, 'admin');
    const grantee = randomUUID() as UserId;

    const res = await run(fakeTx([{ id: grantee }]), engagement, () =>
      controller.addMember(engagementA, { userId: grantee, role: 'member' }),
    );
    expect(res).toEqual({ ok: true });
    expect(await authz.canViewEngagement(grantee, engagementA)).toBe(true);
    expect(await authz.canContributeToEngagement(grantee, engagementA)).toBe(true);
  });

  it('POST :id/members → 403 for a caller who is neither engagement nor tenant admin', async () => {
    await authz.grantEngagementRole(userId, engagementA, 'member');
    await expect(
      run(fakeTx([]), engagement, () =>
        controller.addMember(engagementA, { userId: randomUUID(), role: 'viewer' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('POST :id/members → 403 for a plain tenant member (administer needs admin)', async () => {
    await authz.grantTenantRole(userId, tenantId, 'member');
    await expect(
      run(fakeTx([]), engagement, () =>
        controller.addMember(engagementA, { userId: randomUUID(), role: 'viewer' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('POST :id/members → 400 when the grantee is not in the caller tenant (RLS returns no row)', async () => {
    await authz.grantTenantRole(userId, tenantId, 'admin');
    const outsider = randomUUID() as UserId;
    await expect(
      run(fakeTx([]), engagement, () =>
        controller.addMember(engagementA, { userId: outsider, role: 'viewer' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await authz.canViewEngagement(outsider, engagementA)).toBe(false);
  });

  it('GET /engagements filters the RLS-scoped list through listViewableEngagements', async () => {
    await authz.grantEngagementRole(userId, engagementA, 'viewer');
    const rows = [engagementRow(engagementA), engagementRow(engagementB)];
    const res = await run(fakeTx(rows), undefined, () => controller.list());
    expect(res.map((r) => r.id)).toEqual([engagementA]);
  });

  it('GET /engagements → [] when the caller has no role, even though RLS returned rows', async () => {
    const rows = [engagementRow(engagementA), engagementRow(engagementB)];
    const res = await run(fakeTx(rows), undefined, () => controller.list());
    expect(res).toEqual([]);
  });
});

describe('EngagementsController — AUTHZ_ENFORCE off', () => {
  it('GET :id/audit does not consult authz', async () => {
    const authz = new InMemoryAuthzClient();
    const controller = new EngagementsController(authz, config(false));
    const res = await run(fakeTx([]), engagement, () => controller.audit(engagementA));
    expect(res.rows).toEqual([]);
  });
});
