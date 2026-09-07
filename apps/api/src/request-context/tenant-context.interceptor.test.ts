import 'reflect-metadata';

import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';
import { lastValueFrom, of } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Session } from '../auth/session.service.js';
import { EngagementScope } from './metadata.js';
import { getRequestContext, type RequestContext } from './request-context.js';
import { TenantContextInterceptor } from './tenant-context.interceptor.js';
import type { AuthedRequest } from './tenant-context.guard.js';

const tenantId = '11111111-1111-1111-1111-111111111111' as TenantId;
const userId = '22222222-2222-2222-2222-222222222222' as UserId;
const engagementId = '33333333-3333-3333-3333-333333333333' as EngagementId;

class Routes {
  tenantOnly(): void {}
  @EngagementScope('id')
  engagementScoped(): void {}
}
const routes = new Routes();

interface Chain {
  select: () => Chain;
  from: () => Chain;
  innerJoin: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  orderBy: () => Chain;
  then: <R>(onOk: (v: unknown[]) => R, onErr?: (e: unknown) => R) => Promise<R>;
}

/** A drizzle-query-builder-shaped thenable that ignores every arg and resolves to `rows`. */
function chain(rows: unknown[]): Chain {
  const c: Chain = {
    select: () => c,
    from: () => c,
    innerJoin: () => c,
    where: () => c,
    limit: () => c,
    for: () => c,
    orderBy: () => c,
    then: (onOk, onErr) => Promise.resolve(rows).then(onOk, onErr),
  };
  return c;
}

function fakeDb(engagementRows: unknown[]): Database {
  const tx = {
    execute: () => Promise.resolve([]),
    select: () => chain(engagementRows),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
  return {
    transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx),
  } as unknown as Database;
}

function execContext(handler: () => void, req: Partial<AuthedRequest>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

const session: Session = {
  id: 's1',
  tenantId,
  userId,
  workosUserId: 'wos_1',
  email: 'a@example.com',
  createdAt: new Date(),
};

function capturingHandler(sink: { ctx?: RequestContext }): CallHandler {
  return {
    handle: () => {
      sink.ctx = getRequestContext();
      return of({ ok: true });
    },
  };
}

describe('TenantContextInterceptor', () => {
  const provider = new FakeKeyProvider();
  let wrappedDekB64: string;

  beforeAll(async () => {
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    wrappedDekB64 = Buffer.from(wrappedDek).toString('base64');
  });

  it('opens a tenant transaction and exposes it to the handler (no cipher)', async () => {
    const interceptor = new TenantContextInterceptor(new Reflector(), fakeDb([]), provider);
    const sink: { ctx?: RequestContext } = {};
    const req: Partial<AuthedRequest> = { fdeSession: session, params: {} };

    const result = await lastValueFrom(
      interceptor.intercept(execContext(routes.tenantOnly, req), capturingHandler(sink)),
    );

    expect(result).toEqual({ ok: true });
    expect(sink.ctx?.tenantId).toBe(tenantId);
    expect(sink.ctx?.userId).toBe(userId);
    expect(sink.ctx?.tx).toBeDefined();
    expect(sink.ctx?.engagement).toBeUndefined();
  });

  it('opens withEngagement for an @EngagementScope() route and hands over a live cipher', async () => {
    const rows = [
      { status: 'active', wrappedDek: wrappedDekB64, byokKeyArn: null, tenantCmkArn: 'fake:cmk' },
    ];
    const interceptor = new TenantContextInterceptor(new Reflector(), fakeDb(rows), provider);
    const sink: { ctx?: RequestContext } = {};
    const req: Partial<AuthedRequest> = { fdeSession: session, params: { id: engagementId } };

    await lastValueFrom(
      interceptor.intercept(execContext(routes.engagementScoped, req), capturingHandler(sink)),
    );

    expect(sink.ctx?.engagement?.id).toBe(engagementId);
    const cipher = sink.ctx?.engagement?.cipher;
    expect(cipher).toBeDefined();
    const ct = await cipher!.encryptString('facts.body', 'hello');
    expect(await cipher!.decryptString('facts.body', ct)).toBe('hello');
  });

  it('maps a malformed engagement id to 404 (before the SQL cast)', async () => {
    const interceptor = new TenantContextInterceptor(new Reflector(), fakeDb([]), provider);
    const req: Partial<AuthedRequest> = { fdeSession: session, params: { id: 'not-a-uuid' } };
    await expect(
      lastValueFrom(
        interceptor.intercept(execContext(routes.engagementScoped, req), capturingHandler({})),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('maps a missing engagement to 404', async () => {
    const interceptor = new TenantContextInterceptor(new Reflector(), fakeDb([]), provider);
    const req: Partial<AuthedRequest> = { fdeSession: session, params: { id: engagementId } };

    await expect(
      lastValueFrom(
        interceptor.intercept(execContext(routes.engagementScoped, req), capturingHandler({})),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
