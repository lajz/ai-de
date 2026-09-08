import { afterEach, describe, expect, it, vi } from 'vitest';

import { complete, chatUrl, extractJson, requestBody } from './provider.js';
import type { Config } from './types.js';

const cfg = (over: Partial<Config> = {}): Config =>
  ({
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-test',
    timeoutMs: 1000,
    maxTokens: 64000,
    retries: 2,
    ...over,
  }) as Config;

const okResponse = (content: string, finish = 'stop') =>
  ({
    ok: true,
    json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }),
  }) as Response;

describe('chatUrl', () => {
  it('appends /v1/chat/completions to a bare host', () => {
    expect(chatUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('does not double up when the base already ends in /v1', () => {
    expect(chatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('tolerates a trailing slash', () => {
    expect(chatUrl('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"findings":[]}')).toEqual({ findings: [] });
  });

  it('parses an object inside a ```json fence with prose around it', () => {
    const text = 'Here is my review:\n```json\n{"findings":[{"severity":"high"}]}\n```\nThanks!';
    expect(extractJson<{ findings: unknown[] }>(text).findings).toHaveLength(1);
  });

  it('parses an object embedded in loose prose', () => {
    expect(extractJson('sure: {"ok": true} done')).toEqual({ ok: true });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('requestBody', () => {
  it('sends the configured max_tokens', () => {
    expect(
      requestBody([{ role: 'user', content: 'x' }], cfg({ maxTokens: 12345 })).max_tokens,
    ).toBe(12345);
  });

  it('disables thinking only for deepseek models', () => {
    expect(requestBody([], cfg({ model: 'deepseek-v4-flash' })).thinking).toEqual({
      type: 'disabled',
    });
    expect(requestBody([], cfg({ model: 'qwen3-coder:30b' })).thinking).toBeUndefined();
  });
});

describe('complete — retry', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries a transient failure and then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSL connection timeout'))
      .mockResolvedValueOnce(okResponse('{"findings":[]}'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete([{ role: 'user', content: 'x' }], cfg())).resolves.toContain('findings');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 4xx and surfaces it', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, statusText: 'Unauthorized' } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete([{ role: 'user', content: 'x' }], cfg())).rejects.toThrow(/401/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after retries are exhausted', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network down'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete([{ role: 'user', content: 'x' }], cfg({ retries: 1 }))).rejects.toThrow(
      /network down/,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries an intermittent length-truncation, then accepts a clean response', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(okResponse('{"findings":[{"sev', 'length'))
      .mockResolvedValueOnce(okResponse('{"findings":[]}', 'stop'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(complete([{ role: 'user', content: 'x' }], cfg())).resolves.toBe(
      '{"findings":[]}',
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
