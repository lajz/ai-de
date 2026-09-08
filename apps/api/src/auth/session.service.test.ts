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
