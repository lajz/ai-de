import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderRequestError, StructuredOutputError } from '../errors.js';
import {
  chatCompletionsUrl,
  extractJsonObject,
  OpenAiCompatibleProvider,
} from './openai-compatible.js';

afterEach(() => vi.restoreAllMocks());

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'ERR',
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  } as unknown as Response;
}

function chatBody(content: string, finishReason = 'stop', usage?: Record<string, number>) {
  return {
    choices: [{ message: { content }, finish_reason: finishReason }],
    usage: usage ?? { prompt_tokens: 30, completion_tokens: 10 },
  };
}

describe('chatCompletionsUrl', () => {
  it('appends /v1/chat/completions unless a version segment is already present', () => {
    expect(chatCompletionsUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
    expect(chatCompletionsUrl('http://localhost:11434/v1/')).toBe(
      'http://localhost:11434/v1/chat/completions',
    );
  });
});

describe('extractJsonObject', () => {
  it('pulls an object out of a ```json fence', () => {
    expect(extractJsonObject('prose\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
  });
  it('throws when there is no object', () => {
    expect(() => extractJsonObject('no json here')).toThrow(StructuredOutputError);
  });
});

describe('OpenAiCompatibleProvider', () => {
  it('warns on construction and reports no ZDR', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
    });
    expect(p.zeroDataRetention).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('maps both tiers to the single model unless bulkModel is set', () => {
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://x',
      model: 'm-default',
      bulkModel: 'm-bulk',
      quiet: true,
    });
    expect(p.modelForTier('default')).toBe('m-default');
    expect(p.modelForTier('bulk')).toBe('m-bulk');
  });

  it('completes and normalizes DeepSeek cache-inclusive usage', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        chatBody('the answer', 'stop', {
          prompt_tokens: 100,
          completion_tokens: 12,
          prompt_cache_hit_tokens: 40,
        }),
      ),
    ) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      apiKey: 'sk-x',
      fetchImpl,
      quiet: true,
    });
    const res = await p.complete({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'q' }],
      maxTokens: 1000,
      thinking: 'adaptive',
    });
    expect(res.text).toBe('the answer');
    expect(res.usage).toEqual({
      inputTokens: 60,
      outputTokens: 12,
      cacheReadInputTokens: 40,
      cacheCreationInputTokens: 0,
    });
    // deepseek → thinking disabled is injected
    const sent = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sent.thinking).toEqual({ type: 'disabled' });
  });

  it('extract() parses the JSON object from the completion', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(chatBody('{"facts":[{"type":"decision"}]}')),
    ) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      fetchImpl,
      quiet: true,
    });
    const res = await p.extract({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'extract' }],
      maxTokens: 1000,
      thinking: 'adaptive',
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    });
    expect(res.value).toEqual({ facts: [{ type: 'decision' }] });
    const sent = JSON.parse(
      (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1].body,
    );
    expect(sent.response_format).toEqual({ type: 'json_object' });
  });

  it('throws ProviderRequestError on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'nope' }, false, 500),
    ) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://x',
      model: 'm',
      fetchImpl,
      quiet: true,
    });
    await expect(
      p.complete({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
        thinking: 'adaptive',
      }),
    ).rejects.toThrow(ProviderRequestError);
  });

  it('throws when the completion was truncated (finish_reason: length)', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(chatBody('partial', 'length')),
    ) as unknown as typeof fetch;
    const p = new OpenAiCompatibleProvider({
      baseUrl: 'https://x',
      model: 'm',
      fetchImpl,
      quiet: true,
    });
    await expect(
      p.complete({
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        maxTokens: 10,
        thinking: 'adaptive',
      }),
    ).rejects.toThrow(StructuredOutputError);
  });
});
