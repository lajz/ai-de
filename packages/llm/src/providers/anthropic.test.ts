import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';

import { DataRetentionError, StructuredOutputError } from '../errors.js';
import { AnthropicProvider } from './anthropic.js';

function message(partial: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [],
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: null,
      cache_creation_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: 'standard',
      inference_geo: null,
      output_tokens_details: null,
    },
    ...partial,
  } as Anthropic.Message;
}

function stubClient(over: { create?: unknown; stream?: unknown } = {}) {
  const create = vi.fn(over.create as never);
  const stream = vi.fn(over.stream as never);
  return {
    client: { messages: { create, stream } } as unknown as Pick<Anthropic, 'messages'>,
    create,
    stream,
  };
}

describe('AnthropicProvider — ZDR construction invariant', () => {
  it('defaults to zeroDataRetention: true', () => {
    const { client } = stubClient();
    expect(new AnthropicProvider({ client }).zeroDataRetention).toBe(true);
  });

  it('rejects zeroDataRetention: false on the first-party endpoint (fail closed)', () => {
    expect(() => new AnthropicProvider({ zeroDataRetention: false })).toThrow(DataRetentionError);
  });

  it('allows zeroDataRetention: false only with a non-Anthropic baseURL', () => {
    const p = new AnthropicProvider({
      zeroDataRetention: false,
      baseURL: 'https://bedrock-proxy.internal/anthropic',
    });
    expect(p.zeroDataRetention).toBe(false);
  });

  it('constructs the real SDK client with request logging disabled', () => {
    // No client injected → real Anthropic instance (no network on construction).
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any).client.logLevel).toBe('off');
  });
});

describe('AnthropicProvider — tier mapping', () => {
  it('maps default → opus-5, bulk → sonnet-5', () => {
    const { client } = stubClient();
    const p = new AnthropicProvider({ client });
    expect(p.modelForTier('default')).toBe('claude-opus-5');
    expect(p.modelForTier('bulk')).toBe('claude-sonnet-5');
  });

  it('honours a custom model map', () => {
    const { client } = stubClient();
    const p = new AnthropicProvider({
      client,
      models: { default: 'claude-opus-5', bulk: 'claude-opus-5' },
    });
    expect(p.modelForTier('bulk')).toBe('claude-opus-5');
  });
});

describe('AnthropicProvider.complete', () => {
  it('returns concatenated text and normalized usage', async () => {
    const { client, create } = stubClient({
      create: async () =>
        message({
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'text', text: 'world' },
          ],
          usage: {
            input_tokens: 12,
            output_tokens: 3,
            cache_read_input_tokens: 4,
            cache_creation_input_tokens: 0,
            cache_creation: null,
            server_tool_use: null,
            service_tier: 'standard',
            inference_geo: null,
            output_tokens_details: null,
          },
        }),
    });
    const p = new AnthropicProvider({ client });
    const res = await p.complete({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      thinking: 'adaptive',
    });
    expect(res.text).toBe('Hello world');
    expect(res.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 0,
    });
    expect(create).toHaveBeenCalledOnce();
    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('streams (and coalesces) when maxTokens exceeds the threshold', async () => {
    const finalMessage = vi.fn(async () =>
      message({ content: [{ type: 'text', text: 'streamed' }] }),
    );
    const { client, create, stream } = stubClient({ stream: () => ({ finalMessage }) });
    const p = new AnthropicProvider({ client });
    const res = await p.complete({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64_000,
      thinking: 'adaptive',
    });
    expect(res.text).toBe('streamed');
    expect(stream).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('AnthropicProvider.extract', () => {
  it('reads the structured result from the tool call', async () => {
    const { client, create } = stubClient({
      create: async () =>
        message({
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'here you go' },
            { type: 'tool_use', id: 'tu_1', name: 'record_result', input: { facts: [] } },
          ],
        }),
    });
    const p = new AnthropicProvider({ client });
    const res = await p.extract({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'extract' }],
      maxTokens: 1000,
      thinking: 'adaptive',
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    });
    expect(res.value).toEqual({ facts: [] });
    const body = create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
  });

  it('throws StructuredOutputError when the model never calls the tool', async () => {
    const { client } = stubClient({
      create: async () => message({ content: [{ type: 'text', text: 'no tool' }] }),
    });
    const p = new AnthropicProvider({ client });
    await expect(
      p.extract({
        model: 'claude-opus-5',
        messages: [{ role: 'user', content: 'extract' }],
        maxTokens: 1000,
        thinking: 'adaptive',
        jsonSchema: { type: 'object' },
        schemaName: 'record_result',
      }),
    ).rejects.toThrow(StructuredOutputError);
  });
});
