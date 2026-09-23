import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DataRetentionError,
  OpenAiCompatibleProvider,
  ProviderRequestError,
  StructuredOutputError,
  chatCompletionsUrl,
  extractJsonObject,
  type McpTool,
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

  it('refuses to construct at all under NODE_ENV=production — no non-ZDR provider may ever back a real deployment, agent loop included', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(() => new OpenAiCompatibleProvider(base)).toThrow(DataRetentionError);
    } finally {
      process.env.NODE_ENV = original;
    }
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

describe('OpenAiCompatibleProvider — completeTurn (the agent-loop single-turn primitive)', () => {
  const tool: McpTool = {
    name: 'search_context',
    description: 'search',
    inputSchema: { type: 'object', properties: {} },
  };

  const toolCallChat = (id: string, name: string, args: Record<string, unknown>) => ({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            { id, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 8 },
  });

  it('first turn seeds history from system + messages, sends the OpenAI-shaped tools array, surfaces tool_calls', async () => {
    const fetchImpl = vi.fn(async () =>
      httpJson(toolCallChat('call_1', 'search_context', { query: 'x' })),
    ) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ ...base, fetchImpl });

    const result = await provider.completeTurn!({
      model: 'deepseek-v4-flash',
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      tools: [tool],
      toolResults: [],
    });

    expect(result.toolCalls).toEqual([
      { id: 'call_1', name: 'search_context', input: { query: 'x' } },
    ]);
    expect(result.text).toBe('');
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 8,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });

    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.messages).toEqual([
      { role: 'system', content: 'be helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(sent.tools).toEqual([
      {
        type: 'function',
        function: { name: 'search_context', description: 'search', parameters: tool.inputSchema },
      },
    ]);
  });

  it('a follow-up turn appends toolResults as role:"tool" messages ahead of `history`', async () => {
    const fetchImpl = vi.fn(async () =>
      httpJson(chat('the answer', 'stop', { prompt_tokens: 70, completion_tokens: 12 })),
    ) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ ...base, fetchImpl });
    const priorHistory = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function' as const,
            function: { name: 'search_context', arguments: '{}' },
          },
        ],
      },
    ];

    const result = await provider.completeTurn!({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      tools: [tool],
      history: priorHistory,
      toolResults: [
        {
          id: 'call_1',
          name: 'search_context',
          isError: false,
          content: [{ type: 'text', text: 'found it' }],
        },
      ],
    });

    expect(result.toolCalls).toEqual([]);
    expect(result.text).toBe('the answer');
    expect(result.stopReason).toBe('end_turn');

    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.messages).toEqual([
      ...priorHistory,
      { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
    ]);
  });

  it('injects thinking:disabled for deepseek on completeTurn too', async () => {
    const fetchImpl = vi.fn(async () => httpJson(chat('ok'))) as unknown as typeof fetch;
    const provider = new OpenAiCompatibleProvider({ ...base, fetchImpl });
    await provider.completeTurn!({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      tools: [],
      toolResults: [],
    });
    const sent = JSON.parse((vi.mocked(fetchImpl).mock.calls[0]![1] as RequestInit).body as string);
    expect(sent.thinking).toEqual({ type: 'disabled' });
  });
});
