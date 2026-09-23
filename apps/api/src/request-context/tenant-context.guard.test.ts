import 'reflect-metadata';

import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { TenantId, UserId } from '@fde/core';
import { describe, expect, it, vi } from 'vitest';

import type { ApiKeyIdentity, ApiKeyService } from '../auth/api-key.service.js';
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

function fakeApiKeys(identity?: ApiKeyIdentity): ApiKeyService {
  return { resolve: vi.fn(async () => identity) } as unknown as ApiKeyService;
}

function makeGuard(apiKeys: ApiKeyService = fakeApiKeys()): {
  guard: TenantContextGuard;
  sessions: SessionService;
  apiKeys: ApiKeyService;
} {
  const sessions = new SessionService();
  return { guard: new TenantContextGuard(new Reflector(), sessions, apiKeys), sessions, apiKeys };
}

const routes = new Routes();

describe('TenantContextGuard', () => {
  it('lets @Public() routes through with no session', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(execContext(routes.open, { headers: {} }))).resolves.toBe(true);
  });

  it('401s a secured route with no credentials — before any DB work', async () => {
    const { guard } = makeGuard();
    await expect(guard.canActivate(execContext(routes.secured, { headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('401s a secured route with an unknown bearer token and no matching api key', async () => {
    const { guard } = makeGuard();
    const req = { headers: { authorization: 'Bearer nope' } };
    await expect(guard.canActivate(execContext(routes.secured, req))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('resolves the session and stashes it on the request', async () => {
    const { guard, sessions } = makeGuard();
    const session = sessions.create({
      tenantId: 't-1' as TenantId,
      userId: 'u-1' as UserId,
      workosUserId: 'wos_1',
      email: 'a@example.com',
    });
    const req: Partial<AuthedRequest> = { headers: { authorization: `Bearer ${session.token}` } };

    await expect(guard.canActivate(execContext(routes.secured, req))).resolves.toBe(true);
    expect(req.fdeSession).toBe(session);
  });

  it('treats a revoked session as unauthenticated', async () => {
    const { guard, sessions } = makeGuard();
    const session = sessions.create({
      tenantId: 't-1' as TenantId,
      userId: 'u-1' as UserId,
      workosUserId: 'wos_1',
      email: 'a@example.com',
    });
    sessions.revokeByWorkosUser('wos_1');
    const req = { headers: { authorization: `Bearer ${session.token}` } };
    await expect(guard.canActivate(execContext(routes.secured, req))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  describe('x-api-key credential', () => {
    it('resolves an api key and stashes {tenantId, userId} on the request', async () => {
      const identity: ApiKeyIdentity = { tenantId: 't-1' as TenantId, userId: 'u-1' as UserId };
      const apiKeys = fakeApiKeys(identity);
      const { guard } = makeGuard(apiKeys);
      const req: Partial<AuthedRequest> = { headers: { 'x-api-key': 'fde_whatever' } };

      await expect(guard.canActivate(execContext(routes.secured, req))).resolves.toBe(true);
      expect(req.fdeSession).toEqual(identity);
      expect(apiKeys.resolve).toHaveBeenCalledWith('fde_whatever');
    });

    it('401s when the api key does not resolve', async () => {
      const { guard } = makeGuard(fakeApiKeys(undefined));
      const req = { headers: { 'x-api-key': 'fde_unknown' } };
      await expect(guard.canActivate(execContext(routes.secured, req))).rejects.toThrow(
        UnauthorizedException,
      );
    });

    it('a valid session wins over an api key header on the same request', async () => {
      const { guard, sessions, apiKeys } = makeGuard(
        fakeApiKeys({ tenantId: 't-2' as TenantId, userId: 'u-2' as UserId }),
      );
      const session = sessions.create({
        tenantId: 't-1' as TenantId,
        userId: 'u-1' as UserId,
        workosUserId: 'wos_1',
        email: 'a@example.com',
      });
      const req: Partial<AuthedRequest> = {
        headers: { authorization: `Bearer ${session.token}`, 'x-api-key': 'fde_also-present' },
      };

      await guard.canActivate(execContext(routes.secured, req));
      expect(req.fdeSession).toBe(session);
      expect(apiKeys.resolve).not.toHaveBeenCalled();
    });
  });
});
