import 'reflect-metadata';

import { describe, expect, it } from 'vitest';

import type { Env } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { FakeWorkOsService } from './fake-workos.service.js';
import type { WorkOsPort } from './workos.types.js';

/**
 * `devLoginEnabled()` is the only thing under test here — it reads just
 * `this.workos` and `this.config`, so every other constructor dependency is
 * an unused stub. A real `WorkOsService` (not `FakeWorkOsService`) stands in
 * for "a real WorkOS key is configured" without needing actual WorkOS
 * credentials.
 */
function makeAuthService(opts: { workos: WorkOsPort; env: Partial<Env> }): AuthService {
  const config = { get: (key: keyof Env) => opts.env[key] };
  return new AuthService(
    opts.workos,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    undefined as never,
    config as never,
  );
}

const REAL_WORKOS = {} as WorkOsPort; // anything that isn't a FakeWorkOsService

describe('AuthService.devLoginEnabled', () => {
  it('true only with the fake WorkOS bound, ENABLE_DEV_LOGIN=true, and NODE_ENV=development', () => {
    const svc = makeAuthService({
      workos: new FakeWorkOsService(),
      env: { NODE_ENV: 'development', ENABLE_DEV_LOGIN: 'true' },
    });
    expect(svc.devLoginEnabled()).toBe(true);
  });

  it('false when a real WorkOS provider is bound, even with everything else set', () => {
    const svc = makeAuthService({
      workos: REAL_WORKOS,
      env: { NODE_ENV: 'development', ENABLE_DEV_LOGIN: 'true' },
    });
    expect(svc.devLoginEnabled()).toBe(false);
  });

  it('false when ENABLE_DEV_LOGIN is unset or not exactly "true"', () => {
    const base = { workos: new FakeWorkOsService() };
    expect(makeAuthService({ ...base, env: { NODE_ENV: 'development' } }).devLoginEnabled()).toBe(
      false,
    );
    expect(
      makeAuthService({
        ...base,
        env: { NODE_ENV: 'development', ENABLE_DEV_LOGIN: 'false' },
      }).devLoginEnabled(),
    ).toBe(false);
  });

  it('false under NODE_ENV=test, even with the fake bound and the flag set', () => {
    // The scenario this gate exists for: a non-production environment that
    // isn't a developer's own machine (CI, a shared staging box) shouldn't
    // get the admin-granting bypass just because it also lacks a real
    // WORKOS_API_KEY.
    const svc = makeAuthService({
      workos: new FakeWorkOsService(),
      env: { NODE_ENV: 'test', ENABLE_DEV_LOGIN: 'true' },
    });
    expect(svc.devLoginEnabled()).toBe(false);
  });

  it('false under NODE_ENV=production regardless of the other two', () => {
    const svc = makeAuthService({
      workos: new FakeWorkOsService(),
      env: { NODE_ENV: 'production', ENABLE_DEV_LOGIN: 'true' },
    });
    expect(svc.devLoginEnabled()).toBe(false);
  });
});
