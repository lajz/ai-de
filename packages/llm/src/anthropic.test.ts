import type Anthropic from '@anthropic-ai/sdk';
import type { MCPToolLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { describe, expect, it, vi } from 'vitest';

import { AnthropicProvider, DataRetentionError, StructuredOutputError } from './index.js';

function message(over: Partial<Anthropic.Message>): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    stop_sequence: null,
    content: [],
    usage: {
      input_tokens: 12,
      output_tokens: 3,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 0,
    },
    ...over,
  } as Anthropic.Message;
}

type FullClient = Pick<Anthropic, 'messages'> & { beta: Pick<Anthropic['beta'], 'messages'> };

function stub(create?: unknown, stream?: unknown, toolRunner?: unknown) {
  const fns = { create: vi.fn(create as never), stream: vi.fn(stream as never) };
  const toolRunnerFn = vi.fn(toolRunner as never);
  const client = {
    messages: fns,
    beta: { messages: { toolRunner: toolRunnerFn } },
  } as unknown as FullClient;
  return { client, toolRunnerFn, ...fns };
}

describe('AnthropicProvider — ZDR construction invariant', () => {
  it('defaults on, fails closed on first-party, allows off only with a non-Anthropic baseURL', () => {
    expect(new AnthropicProvider({ client: stub().client }).zeroDataRetention).toBe(true);
    expect(() => new AnthropicProvider({ zeroDataRetention: false })).toThrow(DataRetentionError);
    expect(
      new AnthropicProvider({ zeroDataRetention: false, baseURL: 'https://bedrock.internal' })
        .zeroDataRetention,
    ).toBe(false);
  });

  it('builds the real SDK client with request logging disabled', () => {
    const p = new AnthropicProvider({ apiKey: 'sk-test' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((p as any).client.logLevel).toBe('off');
  });
});

describe('AnthropicProvider — routing + calls', () => {
  it('maps default → opus-5, bulk → sonnet-5 (overridable)', () => {
    const p = new AnthropicProvider({ client: stub().client });
    expect([p.modelForTier('default'), p.modelForTier('bulk')]).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    const custom = new AnthropicProvider({
      client: stub().client,
      models: { default: 'claude-opus-5', bulk: 'claude-opus-5' },
    });
    expect(custom.modelForTier('bulk')).toBe('claude-opus-5');
  });

  it('complete: concatenates text, normalizes usage, defaults thinking to adaptive', async () => {
    const s = stub(async () =>
      message({
        content: [
          { type: 'text', text: 'Hello ' },
          { type: 'text', text: 'world' },
        ],
      }),
    );
    const res = await new AnthropicProvider({ client: s.client }).complete({
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
    const body = s.create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(body.thinking).toEqual({ type: 'adaptive' });
  });

  it('complete: streams + coalesces when maxTokens exceeds the threshold', async () => {
    const finalMessage = vi.fn(async () =>
      message({ content: [{ type: 'text', text: 'streamed' }] }),
    );
    const s = stub(undefined, () => ({ finalMessage }));
    const res = await new AnthropicProvider({ client: s.client }).complete({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 64_000,
      thinking: 'adaptive',
    });
    expect(res.text).toBe('streamed');
    expect(s.stream).toHaveBeenCalledOnce();
    expect(s.create).not.toHaveBeenCalled();
  });

  it('extract: reads the tool call (auto tool_choice), or throws when the model skips it', async () => {
    const withCall = stub(async () =>
      message({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'record_result', input: { facts: [] } }],
      }),
    );
    const req = {
      model: 'claude-opus-5',
      messages: [{ role: 'user' as const, content: 'extract' }],
      maxTokens: 1000,
      thinking: 'adaptive' as const,
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    };
    const res = await new AnthropicProvider({ client: withCall.client }).extract(req);
    expect(res.value).toEqual({ facts: [] });
    const body = withCall.create.mock.calls[0]![0] as Anthropic.MessageCreateParamsNonStreaming;
    expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });

    const noCall = stub(async () => message({ content: [{ type: 'text', text: 'nope' }] }));
    const err = await new AnthropicProvider({ client: noCall.client })
      .extract(req)
      .catch((e) => e as StructuredOutputError);
    expect(err).toBeInstanceOf(StructuredOutputError);
    // The failed call was still billed — usage rides along for the router to meter.
    expect(err.usage).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      cacheReadInputTokens: 4,
      cacheCreationInputTokens: 0,
    });
  });

  it('runAgentLoop: converts MCP tools via mcpTools(), emits tool_call/tool_result/text/usage in order', async () => {
    const tool: MCPToolLike = {
      name: 'search_context',
      description: 'search',
      inputSchema: { type: 'object', properties: {} },
    };
    const mcpClient = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'found it' }],
        isError: false,
      })),
    };

    const toolRunnerFn = async function* (params: {
      tools: { run: (i: unknown) => Promise<unknown> }[];
    }) {
      yield message({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'search_context', input: { query: 'x' } }],
      }) as unknown as BetaMessage;
      // Simulate Tool Runner actually invoking the tool between turns.
      await params.tools[0]!.run({ query: 'x' });
      yield message({ content: [{ type: 'text', text: 'the answer' }] }) as unknown as BetaMessage;
    };

    const s = stub(undefined, undefined, toolRunnerFn);
    const provider = new AnthropicProvider({ client: s.client });
    const events: unknown[] = [];
    for await (const e of provider.runAgentLoop!({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      maxIterations: 4,
      mcpTools: [tool],
      mcpClient,
    })) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: 'tool_call', name: 'search_context', input: { query: 'x' } },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 0,
        },
      },
      {
        type: 'tool_result',
        name: 'search_context',
        isError: false,
        content: [{ type: 'text', text: 'found it' }],
      },
      { type: 'text', text: 'the answer' },
      {
        type: 'usage',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadInputTokens: 4,
          cacheCreationInputTokens: 0,
        },
      },
    ]);
    expect(mcpClient.callTool).toHaveBeenCalledWith({
      name: 'search_context',
      arguments: { query: 'x' },
    });
    const params = s.toolRunnerFn.mock.calls[0]![0] as { model: string; max_iterations: number };
    expect(params.model).toBe('claude-opus-5');
    expect(params.max_iterations).toBe(4);
  });

  it('runAgentLoop: an errored tool call still emits a tool_result event with isError true', async () => {
    const tool: MCPToolLike = {
      name: 'search_context',
      inputSchema: { type: 'object', properties: {} },
    };
    const mcpClient = {
      callTool: vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'boom' }],
        isError: true,
      })),
    };
    const toolRunnerFn = async function* (params: {
      tools: { run: (i: unknown) => Promise<unknown> }[];
    }) {
      yield message({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'search_context', input: {} }],
      }) as unknown as BetaMessage;
      await params.tools[0]!.run({}).catch(() => {
        /* mcpTool's run() rethrows ToolError on isError — our wrapper already recorded the event by then */
      });
      yield message({
        content: [{ type: 'text', text: 'sorry, failed' }],
      }) as unknown as BetaMessage;
    };
    const s = stub(undefined, undefined, toolRunnerFn);
    const provider = new AnthropicProvider({ client: s.client });
    const events: unknown[] = [];
    for await (const e of provider.runAgentLoop!({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 1000,
      maxIterations: 4,
      mcpTools: [tool],
      mcpClient,
    })) {
      events.push(e);
    }
    expect(events).toContainEqual({
      type: 'tool_result',
      name: 'search_context',
      isError: true,
      content: [{ type: 'text', text: 'boom' }],
    });
  });

  it('extract: streams + coalesces when maxTokens exceeds the threshold', async () => {
    const finalMessage = vi.fn(async () =>
      message({
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 't1', name: 'record_result', input: { facts: [] } }],
      }),
    );
    const s = stub(undefined, () => ({ finalMessage }));
    const res = await new AnthropicProvider({ client: s.client }).extract({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'extract' }],
      maxTokens: 64_000,
      thinking: 'adaptive',
      jsonSchema: { type: 'object' },
      schemaName: 'record_result',
    });
    expect(res.value).toEqual({ facts: [] });
    expect(s.stream).toHaveBeenCalledOnce();
    expect(s.create).not.toHaveBeenCalled();
  });
});
