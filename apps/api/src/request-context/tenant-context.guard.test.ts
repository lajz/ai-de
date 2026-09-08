import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantId, UserId } from '@fde/core';
import { describe, expect, it } from 'vitest';

import { SessionService } from '../auth/session.service.js';
import { Public } from './metadata.js';
import { type AuthedRequest, TenantContextGuard } from './tenant-context.guard.js';

class Routes {
  @Public()
  open(): void {}
  secured(): void {}
}

function execContext(handler: () => void, req: Partial<AuthedRequest>): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => Routes,
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({}), getNext: () => ({}) }),
  } as unknown as ExecutionContext;
}

function makeGuard(): { guard: TenantContextGuard; sessions: SessionService } {
  const sessions = new SessionService();
  return { guard: new TenantContextGuard(new Reflector(), sessions), sessions };
}

const routes = new Routes();

describe('TenantContextGuard', () => {
  it('lets @Public() routes through with no session', () => {
    const { guard } = makeGuard();
    expect(guard.canActivate(execContext(routes.open, { headers: {} }))).toBe(true);
  });

  it('401s a secured route with no credentials — before any DB work', () => {
    const { guard } = makeGuard();
    expect(() => guard.canActivate(execContext(routes.secured, { headers: {} }))).toThrow(
      UnauthorizedException,
    );
  });

  it('401s a secured route with an unknown bearer token', () => {
    const { guard } = makeGuard();
    const req = { headers: { authorization: 'Bearer nope' } };
    expect(() => guard.canActivate(execContext(routes.secured, req))).toThrow(
      UnauthorizedException,
    );
  });

  it('resolves the session and stashes it on the request', () => {
    const { guard, sessions } = makeGuard();
    const session = sessions.create({
      tenantId: 't-1' as TenantId,
      userId: 'u-1' as UserId,
      workosUserId: 'wos_1',
      email: 'a@example.com',
    });
    const req: Partial<AuthedRequest> = { headers: { authorization: `Bearer ${session.token}` } };

    expect(guard.canActivate(execContext(routes.secured, req))).toBe(true);
    expect(req.fdeSession).toBe(session);
  });

  it('treats a revoked session as unauthenticated', () => {
    const { guard, sessions } = makeGuard();
    const session = sessions.create({
      tenantId: 't-1' as TenantId,
      userId: 'u-1' as UserId,
      workosUserId: 'wos_1',
      email: 'a@example.com',
    });
    sessions.revokeByWorkosUser('wos_1');
    const req = { headers: { authorization: `Bearer ${session.token}` } };
    expect(() => guard.canActivate(execContext(routes.secured, req))).toThrow(
      UnauthorizedException,
    );
  });
});
