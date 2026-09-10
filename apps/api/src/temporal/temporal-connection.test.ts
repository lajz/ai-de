import { describe, expect, it } from 'vitest';

import type { Env } from '../config/env.js';
import { loadTemporalClientConfig } from './temporal-connection.js';

const env = (o: Partial<Env>) => o as Env;

describe('loadTemporalClientConfig', () => {
  it('returns null when TEMPORAL_ADDRESS is unset', () => {
    expect(loadTemporalClientConfig(env({}))).toBeNull();
  });

  it('builds a no-TLS local config from the address alone', () => {
    const cfg = loadTemporalClientConfig(env({ TEMPORAL_ADDRESS: 'localhost:7233' }));
    expect(cfg).toEqual({
      address: 'localhost:7233',
      namespace: 'default',
      connection: { address: 'localhost:7233' },
    });
  });

  it('uses TEMPORAL_API_KEY (TLS, no client cert) and the given namespace', () => {
    const cfg = loadTemporalClientConfig(
      env({
        TEMPORAL_ADDRESS: 'ns.tmprl.cloud:7233',
        TEMPORAL_NAMESPACE: 'ns',
        TEMPORAL_API_KEY: 'k',
      }),
    );
    expect(cfg).toMatchObject({
      namespace: 'ns',
      connection: { address: 'ns.tmprl.cloud:7233', tls: true, apiKey: 'k' },
    });
  });

  it('uses an mTLS client cert pair when both halves are present', () => {
    const cfg = loadTemporalClientConfig(
      env({ TEMPORAL_ADDRESS: 'a:7233', TEMPORAL_CLIENT_CERT: 'CRT', TEMPORAL_CLIENT_KEY: 'KEY' }),
    );
    expect(cfg?.connection).toMatchObject({ tls: { clientCertPair: {} } });
  });

  it('throws on a half-configured mTLS pair', () => {
    expect(() =>
      loadTemporalClientConfig(env({ TEMPORAL_ADDRESS: 'a:7233', TEMPORAL_CLIENT_CERT: 'CRT' })),
    ).toThrow(/half-configured/);
  });

  it('throws when both mTLS and an API key are set', () => {
    expect(() =>
      loadTemporalClientConfig(
        env({
          TEMPORAL_ADDRESS: 'a:7233',
          TEMPORAL_CLIENT_CERT: 'CRT',
          TEMPORAL_CLIENT_KEY: 'KEY',
          TEMPORAL_API_KEY: 'k',
        }),
      ),
    ).toThrow(/pick one auth method/);
  });
});
