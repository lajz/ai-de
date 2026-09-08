import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.js';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('validateEnv', () => {
  it('accepts a minimal dev environment and applies defaults', () => {
    const env = validateEnv({ ...base });
    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.WORKOS_ORG_TENANT_MAP).toEqual({});
  });

  it('fails fast when DATABASE_URL is missing', () => {
    expect(() => validateEnv({})).toThrow(/DATABASE_URL/);
  });

  it('parses WORKOS_ORG_TENANT_MAP JSON', () => {
    const tenantId = '11111111-1111-1111-1111-111111111111';
    const env = validateEnv({ ...base, WORKOS_ORG_TENANT_MAP: `{"org_1":"${tenantId}"}` });
    expect(env.WORKOS_ORG_TENANT_MAP).toEqual({ org_1: tenantId });
  });

  it('rejects a non-JSON WORKOS_ORG_TENANT_MAP', () => {
    expect(() => validateEnv({ ...base, WORKOS_ORG_TENANT_MAP: 'not json' })).toThrow(
      /WORKOS_ORG_TENANT_MAP/,
    );
  });

  it('rejects WORKOS_ORG_TENANT_MAP with a non-UUID tenant id', () => {
    expect(() => validateEnv({ ...base, WORKOS_ORG_TENANT_MAP: '{"org_1":"not-a-uuid"}' })).toThrow(
      /UUID/,
    );
  });

  it('requires WorkOS credentials under NODE_ENV=production', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production' })).toThrow(/WORKOS_API_KEY/);
  });

  it('refuses FDE_FAKE_KMS=true under NODE_ENV=production', () => {
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'production',
        WORKOS_API_KEY: 'k',
        WORKOS_CLIENT_ID: 'c',
        WORKOS_WEBHOOK_SECRET: 's',
        FDE_FAKE_KMS: 'true',
      }),
    ).toThrow(/FDE_FAKE_KMS/);
  });
});
