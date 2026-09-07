import { describe, expect, it } from 'vitest';

import { loadTemporalConnectionConfig } from './connection.js';

describe('loadTemporalConnectionConfig', () => {
  it('defaults to the local dev server with no TLS', () => {
    const cfg = loadTemporalConnectionConfig({});
    expect(cfg).toEqual({ address: 'localhost:7233', namespace: 'default' });
  });

  it('accepts an explicit localhost address', () => {
    const cfg = loadTemporalConnectionConfig({ TEMPORAL_ADDRESS: '127.0.0.1:7233' });
    expect(cfg.tls).toBeUndefined();
  });

  it('builds mTLS config from a cert + key pair', () => {
    const cfg = loadTemporalConnectionConfig({
      TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233',
      TEMPORAL_NAMESPACE: 'my-namespace',
      TEMPORAL_CLIENT_CERT: 'cert-pem',
      TEMPORAL_CLIENT_KEY: 'key-pem',
    });
    expect(cfg.namespace).toBe('my-namespace');
    expect(cfg.tls).toMatchObject({
      clientCertPair: { crt: Buffer.from('cert-pem'), key: Buffer.from('key-pem') },
    });
  });

  it('builds API-key config', () => {
    const cfg = loadTemporalConnectionConfig({
      TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233',
      TEMPORAL_API_KEY: 'secret',
    });
    expect(cfg.tls).toBe(true);
    expect(cfg.apiKey).toBe('secret');
  });

  it('fails clearly when only the cert half of mTLS is set', () => {
    expect(() =>
      loadTemporalConnectionConfig({
        TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233',
        TEMPORAL_CLIENT_CERT: 'cert-pem',
      }),
    ).toThrow(/half-configured/i);
  });

  it('fails clearly when only the key half of mTLS is set', () => {
    expect(() =>
      loadTemporalConnectionConfig({
        TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233',
        TEMPORAL_CLIENT_KEY: 'key-pem',
      }),
    ).toThrow(/half-configured/i);
  });

  it('fails clearly when both mTLS and an API key are set', () => {
    expect(() =>
      loadTemporalConnectionConfig({
        TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233',
        TEMPORAL_CLIENT_CERT: 'cert-pem',
        TEMPORAL_CLIENT_KEY: 'key-pem',
        TEMPORAL_API_KEY: 'secret',
      }),
    ).toThrow(/pick one auth method/i);
  });

  it('fails clearly for a non-local address with no credentials', () => {
    expect(() =>
      loadTemporalConnectionConfig({ TEMPORAL_ADDRESS: 'my-namespace.a1b2c.tmprl.cloud:7233' }),
    ).toThrow(/neither mTLS.*nor TEMPORAL_API_KEY/i);
  });
});
