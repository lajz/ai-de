import { describe, expect, it } from 'vitest';

import { FakeNangoClient } from './fake-nango-client.js';
import { NangoApiError } from './nango-client.js';
import { HttpNangoClient } from './http-nango-client.js';

describe('FakeNangoClient', () => {
  it('returns a deterministic token + metadata and records every call', async () => {
    const nango = new FakeNangoClient({ accessToken: 'tok-1', metadata: { workspace: 'ws-9' } });
    const conn = await nango.getConnection('conn-1', 'linear');
    expect(conn).toMatchObject({ accessToken: 'tok-1', metadata: { workspace: 'ws-9' } });
    await nango.getConnection('conn-1', 'linear');
    expect(nango.calls).toEqual([
      ['conn-1', 'linear'],
      ['conn-1', 'linear'],
    ]);
  });

  it('rejects an unknown connection id', async () => {
    const nango = new FakeNangoClient({ unknownConnectionIds: ['gone'] });
    await expect(nango.getConnection('gone', 'linear')).rejects.toThrow(/no connection/);
  });
});

/** Minimal fetch stub — records requests, returns a canned response. */
function stubFetch(response: { status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ''),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpNangoClient', () => {
  it('rejects construction without a secret key', () => {
    expect(() => new HttpNangoClient({ secretKey: '' })).toThrow(/secretKey is required/);
  });

  it('GETs /connection with a Bearer key + provider_config_key, returns the fresh token', async () => {
    const { impl, calls } = stubFetch({
      json: {
        metadata: { workspace: 'org-1', region: 'us' },
        credentials: { access_token: 'fresh-token', expires_at: '2030-01-01T00:00:00.000Z' },
      },
    });
    const conn = await new HttpNangoClient({
      secretKey: 'nango_sk_test',
      serverUrl: 'http://nango:3003',
      fetchImpl: impl,
    }).getConnection('conn-42', 'linear');

    expect(conn).toEqual({
      accessToken: 'fresh-token',
      expiresAt: '2030-01-01T00:00:00.000Z',
      metadata: { workspace: 'org-1', region: 'us' },
    });
    const url = new URL(calls[0]!.url);
    expect(url.pathname).toBe('/connection/conn-42');
    expect(url.searchParams.get('provider_config_key')).toBe('linear');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer nango_sk_test',
    );
  });

  it('raises NangoApiError on a non-2xx response', async () => {
    const { impl } = stubFetch({ status: 404, text: '{"error":"unknown connection"}' });
    await expect(
      new HttpNangoClient({ secretKey: 'k', fetchImpl: impl }).getConnection('x', 'linear'),
    ).rejects.toBeInstanceOf(NangoApiError);
  });

  it('raises NangoApiError when the response carries no access token', async () => {
    const { impl } = stubFetch({ json: { credentials: {} } });
    await expect(
      new HttpNangoClient({ secretKey: 'k', fetchImpl: impl }).getConnection('x', 'linear'),
    ).rejects.toThrow(/no access token/);
  });
});
