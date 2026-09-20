import 'reflect-metadata';

import type { TenantId, UserId } from '@fde/core';
import { describe, expect, it } from 'vitest';

import { SessionService } from './session.service.js';

const NEW = {
  tenantId: 't_1' as TenantId,
  userId: 'u_1' as UserId,
  workosUserId: 'wos_1',
  email: 'a@example.com',
};

describe('SessionService.resolve', () => {
  it('returns the session for its own token', () => {
    const svc = new SessionService();
    const session = svc.create(NEW);
    expect(svc.resolve(session.token)).toBe(session);
  });

  it('returns undefined for an unknown or empty token', () => {
    const svc = new SessionService();
    svc.create(NEW);
    expect(svc.resolve('not-a-real-token')).toBeUndefined();
    expect(svc.resolve(undefined)).toBeUndefined();
  });

  it('resolves the right session when several are stored', () => {
    const svc = new SessionService();
    const a = svc.create(NEW);
    const b = svc.create({ ...NEW, userId: 'u_2' as UserId, workosUserId: 'wos_2' });
    expect(svc.resolve(a.token)).toBe(a);
    expect(svc.resolve(b.token)).toBe(b);
  });

  it('stops resolving a token once its session is revoked', () => {
    const svc = new SessionService();
    const session = svc.create(NEW);
    expect(svc.revokeByWorkosUser('wos_1')).toBe(1);
    expect(svc.resolve(session.token)).toBeUndefined();
  });
});

describe('SessionService.createWithFixedToken', () => {
  it('resolves under the exact token supplied, not a generated one', () => {
    const svc = new SessionService();
    const session = svc.createWithFixedToken('fixed-token-123', NEW);
    expect(session.token).toBe('fixed-token-123');
    expect(svc.resolve('fixed-token-123')).toBe(session);
  });

  it('re-seeding the same fixed token replaces the prior session under it', () => {
    // The scenario `AuthService#onModuleInit` relies on: a `tsx watch`
    // restart calls this again with the same `DEV_SESSION_TOKEN`, and the
    // token must keep resolving — now to the freshly provisioned session,
    // not the stale one from before the restart.
    const svc = new SessionService();
    const first = svc.createWithFixedToken('fixed-token-123', NEW);
    const second = svc.createWithFixedToken('fixed-token-123', {
      ...NEW,
      userId: 'u_2' as UserId,
      workosUserId: 'wos_2',
    });
    expect(svc.resolve('fixed-token-123')).toBe(second);
    expect(svc.resolve('fixed-token-123')).not.toBe(first);
  });

  it('a fixed-token session revokes the same as any other', () => {
    const svc = new SessionService();
    svc.createWithFixedToken('fixed-token-123', NEW);
    expect(svc.revokeByWorkosUser('wos_1')).toBe(1);
    expect(svc.resolve('fixed-token-123')).toBeUndefined();
  });
});
