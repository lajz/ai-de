import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  OpenAiCompatibleProvider,
  ProviderRequestError,
  StructuredOutputError,
  chatCompletionsUrl,
  extractJsonObject,
} from './index.js';

afterEach(() => vi.restoreAllMocks());

const httpJson = (body: unknown, ok = true, status = 200): Response =>
  ({ ok, status, statusText: ok ? 'OK' : 'ERR', json: async () => body }) as unknown as Response;

const chat = (content: string, finish = 'stop', usage?: Record<string, number>) => ({
  choices: [{ message: { content }, finish_reason: finish }],
  usage: usage ?? { prompt_tokens: 30, completion_tokens: 10 },
});

const base = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  quiet: true,
} as const;

describe('helpers', () => {
  it('chatCompletionsUrl adds /v1/chat/completions unless a version segment is present', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });

  it('extractJsonObject pulls an object from a ```json fence, or throws', () => {
    expect(extractJsonObject('x\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJsonObject('no json')).toThrow(StructuredOutputError);
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('warns on construction, reports no ZDR, maps tiers', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new OpenAiCompatibleProvider({ ...base, quiet: false, bulkModel: 'm-bulk' });
    expect(p.zeroDataRetention).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
    expect([p.modelForTier('default'), p.modelForTier('bulk')]).toEqual([
      'deepseek-v4-flash',
      'm-bulk',
    ]);
  });

  it('completes, injects thinking:disabled for deepseek, normalizes cache-inclusive usage', async () => {
    const fetchImpl = vi.fn(async () =>
      httpJson(
        chat('the answer', 'stop', {
          prompt_tokens: 100,
          completion_tokens: 12,
          prompt_cache_hit_tokens: 40,
        }),
      ),
    ) as unknown as typeof fetch;

    const res = await new OpenAiCompatibleProvider({ ...base, apiKey: 'sk-x', fetchImpl }).complete(
      {
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 1000,
        thinking: 'adaptive',
      },
    );
    expect(res.text).toBe('the answer');
    expect(res.usage).toEqual({
      inputTokens: 60,
      outputTokens: 12,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
    });
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.thinking).toEqual({ type: 'disabled' });
  });

  it('extract parses the JSON object and asks for response_format json_object', async () => {
    const fetchImpl = vi.fn(async () =>
      httpJson(chat('{"facts":[{"type":"decision"}]}')),
    ) as unknown as typeof fetch;
    const res = await new OpenAiCompatibleProvider({ ...base, fetchImpl }).extract({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'extract' }],
      maxTokens: 1000,
      thinking: 'adaptive',
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    });
    expect(res.value).toEqual({ facts: [{ type: 'decision' }] });
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.response_format).toEqual({ type: 'json_object' });
  });

  it('throws on a non-2xx response and on a truncated completion', async () => {
    const http500 = vi.fn(async () => httpJson({}, false, 500)) as unknown as typeof fetch;
    const truncated = vi.fn(async () =>
      httpJson(chat('partial', 'length')),
    ) as unknown as typeof fetch;
    const call = (fetchImpl: typeof fetch) =>
      new OpenAiCompatibleProvider({ ...base, fetchImpl }).complete({
        model: 'deepseek-v4-flash',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
        thinking: 'adaptive',
      });
    await expect(call(http500)).rejects.toThrow(ProviderRequestError);
    await expect(call(truncated)).rejects.toThrow(StructuredOutputError);
  });

  const extract = (fetchImpl: typeof fetch) =>
    new OpenAiCompatibleProvider({ ...base, fetchImpl }).extract({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'extract' }],
      maxTokens: 1000,
      thinking: 'adaptive',
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    });

  it('extract: a failure the provider still billed carries usage for the router to meter', async () => {
    const unparseable = vi.fn(async () =>
      httpJson(chat('not json at all', 'stop', { prompt_tokens: 40, completion_tokens: 5 })),
    ) as unknown as typeof fetch;
    const err = await extract(unparseable).catch((e) => e as StructuredOutputError);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect(err.usage).toMatchObject({ inputTokens: 40, outputTokens: 5 });
  });

  it('extract: propagates a truncated (finish_reason=length) response with usage attached', async () => {
    const truncated = vi.fn(async () =>
      httpJson(chat('{"facts":[', 'length', { prompt_tokens: 60, completion_tokens: 1000 })),
    ) as unknown as typeof fetch;
    const err = await extract(truncated).catch((e) => e as StructuredOutputError);
    expect(err).toBeInstanceOf(StructuredOutputError);
    expect(err.usage).toMatchObject({ inputTokens: 60, outputTokens: 1000 });
  });
});
