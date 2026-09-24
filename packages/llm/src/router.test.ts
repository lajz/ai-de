import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  AgentLoopUnsupportedError,
  DataRetentionError,
  StructuredOutputError,
  createRouter,
  type LlmProvider,
  type ProviderCompleteRequest,
  type ProviderExtractRequest,
  type ProviderTokenUsage,
  type ProviderToolCall,
  type ProviderTurnRequest,
  type ProviderTurnResult,
  type Tier,
  type UsageRecord,
} from './index.js';

const USAGE: ProviderTokenUsage = {
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};

interface FakeOpts {
  zeroDataRetention?: boolean;
  completeText?: string;
  extractValue?: unknown;
  onComplete?: (r: ProviderCompleteRequest) => void;
  onExtract?: (r: ProviderExtractRequest) => void;
  /** Scripted turn results, returned one per `completeTurn` call in order. */
  turns?: ProviderTurnResult[];
  onCompleteTurn?: (r: ProviderTurnRequest) => void;
}

function fakeProvider(o: FakeOpts = {}): LlmProvider {
  let turnIndex = 0;
  return {
    name: 'fake',
    zeroDataRetention: o.zeroDataRetention ?? true,
    modelForTier: (t: Tier) => (t === 'bulk' ? 'claude-sonnet-5' : 'claude-opus-5'),
    async complete(r) {
      o.onComplete?.(r);
      return { text: o.completeText ?? 'ok', usage: USAGE };
    },
    async extract(r) {
      o.onExtract?.(r);
      return { value: o.extractValue ?? { facts: [] }, usage: USAGE };
    },
    ...(o.turns
      ? {
          async completeTurn(r: ProviderTurnRequest) {
            o.onCompleteTurn?.(r);
            const result = o.turns![turnIndex];
            turnIndex += 1;
            if (!result) throw new Error('fakeProvider: no more scripted turns');
            return result;
          },
        }
      : {}),
  };
}

/** A minimal scripted turn — everything but `toolCalls`/`text` defaults sensibly. */
function turn(over: Partial<ProviderTurnResult> = {}): ProviderTurnResult {
  return {
    history: over.history ?? [],
    toolCalls: over.toolCalls ?? [],
    text: over.text ?? '',
    usage: over.usage ?? USAGE,
    stopReason: over.stopReason ?? (over.toolCalls?.length ? 'tool_use' : 'end_turn'),
  };
}

function toolCall(over: Partial<ProviderToolCall> = {}): ProviderToolCall {
  return { id: over.id ?? 't1', name: over.name ?? 'search_context', input: over.input ?? {} };
}

describe('createRouter — routing', () => {
  it('maps tier → model (default tier default), lets an explicit model win, resolves a registry prompt', async () => {
    const seen: ProviderCompleteRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onComplete: (r) => seen.push(r) }) });

    await router.complete({ messages: 'hi' });
    await router.complete({ tier: 'bulk', messages: 'hi' });
    await router.complete({ tier: 'bulk', model: 'claude-opus-5', messages: 'hi' });
    const { usage } = await router.complete({
      tier: 'bulk',
      prompt: { name: 'extraction' },
      messages: 'chunk',
    });

    expect(seen.map((s) => s.model)).toEqual([
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-sonnet-5',
    ]);
    expect(seen[3]!.system).toContain('You extract a structured record');
    expect(seen[0]!.thinking).toBe('adaptive');
    expect(usage.promptVersion).toBe('2026-02-14');
  });
});

describe('createRouter — UsageRecord', () => {
  it('has exactly the allowed keys, prices from the rate table, fires onUsage, leaks no text', async () => {
    const secret = 'CANARY-transcript-body';
    let record: UsageRecord | undefined;
    const router = createRouter({
      provider: fakeProvider({ completeText: `... ${secret} ...` }),
      now: (() => {
        let t = 1000;
        return () => (t += 50);
      })(),
      onUsage: (r) => {
        record = r;
      },
    });

    const { usage } = await router.complete({
      system: `sys ${secret}`,
      messages: `user ${secret}`,
    });
    expect(record).toEqual(usage);
    expect(new Set(Object.keys(usage))).toEqual(
      new Set([
        'provider',
        'model',
        'tier',
        'promptVersion',
        'inputTokens',
        'outputTokens',
        'cacheReadInputTokens',
        'cacheCreationInputTokens',
        'costUsd',
        'pricedFrom',
        'latencyMs',
      ]),
    );
    expect(usage.costUsd).toBeCloseTo((1000 * 5 + 200 * 25) / 1_000_000, 10);
    expect(usage.pricedFrom).toBe('claude-opus-5');
    expect(usage.latencyMs).toBe(50);
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('an unpriced model costs 0 / pricedFrom null; onUsage also fires for extract()', async () => {
    const onUsage = vi.fn();
    const router = createRouter({ provider: fakeProvider(), onUsage });
    const { usage } = await router.complete({ model: 'some-local-model', messages: 'hi' });
    expect([usage.costUsd, usage.pricedFrom]).toEqual([0, null]);

    await router.extract(z.object({ facts: z.array(z.unknown()) }), { messages: 'x' });
    expect(onUsage).toHaveBeenCalledTimes(2);
  });
});

describe('createRouter — extract validation', () => {
  const schema = z.object({ facts: z.array(z.object({ type: z.string() })) });

  it('returns the parsed value on a valid response and throws (with issues) on a malformed one', async () => {
    const good = createRouter({
      provider: fakeProvider({ extractValue: { facts: [{ type: 'decision' }] } }),
    });
    expect((await good.extract(schema, { messages: 'x' })).value).toEqual({
      facts: [{ type: 'decision' }],
    });

    const onUsage = vi.fn();
    const bad = createRouter({
      provider: fakeProvider({ extractValue: { facts: [{ nope: true }] } }),
      onUsage,
    });
    const err = await bad
      .extract(schema, { messages: 'x' })
      .catch((e) => e as StructuredOutputError);
    expect(err).toBeInstanceOf(StructuredOutputError);
    // Usage is emitted once and also rides on the error for a catching caller.
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(err.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it('meters a billed call even when the provider throws StructuredOutputError with usage', async () => {
    const onUsage = vi.fn();
    const provider: LlmProvider = {
      ...fakeProvider(),
      async extract() {
        throw new StructuredOutputError('model did not call the tool', undefined, USAGE);
      },
    };
    const router = createRouter({ provider, onUsage });
    await expect(router.extract(schema, { messages: 'x' })).rejects.toThrow(StructuredOutputError);
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]![0]).toMatchObject({ inputTokens: 1000, outputTokens: 200 });
  });

  it('does not meter when the provider throws without usage (call never landed)', async () => {
    const onUsage = vi.fn();
    const provider: LlmProvider = {
      ...fakeProvider(),
      async extract() {
        throw new StructuredOutputError('no JSON object found in model response');
      },
    };
    const router = createRouter({ provider, onUsage });
    await expect(router.extract(schema, { messages: 'x' })).rejects.toThrow(StructuredOutputError);
    expect(onUsage).not.toHaveBeenCalled();
  });

  it('passes the caller jsonSchema + schemaName through to the provider', async () => {
    const seen: ProviderExtractRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onExtract: (r) => seen.push(r) }) });
    await router.extract(schema, {
      messages: 'x',
      jsonSchema: { type: 'object', title: 'X' },
      schemaName: 'my_schema',
    });
    expect(seen[0]!.jsonSchema).toEqual({ type: 'object', title: 'X' });
    expect(seen[0]!.schemaName).toBe('my_schema');
  });
});

describe('createRouter — runAgentLoop', () => {
  const mcpTools = [{ name: 'search_context', inputSchema: { type: 'object' as const } }];

  function fakeMcpClient(result: { isError?: boolean; content: unknown } = { content: 'x' }) {
    return { callTool: vi.fn(async () => result) };
  }

  it('throws AgentLoopUnsupportedError when the active provider has no completeTurn', async () => {
    const router = createRouter({ provider: fakeProvider() });
    const drain = async () => {
      for await (const _ of router.runAgentLoop({
        messages: 'hi',
        maxIterations: 4,
        mcpTools,
        mcpClient: fakeMcpClient(),
      })) {
        // never reached
      }
    };
    await expect(drain()).rejects.toThrow(AgentLoopUnsupportedError);
  });

  it('resolves tier→model and forwards maxTokens/tools/messages to completeTurn', async () => {
    const seen: ProviderTurnRequest[] = [];
    const router = createRouter({
      provider: fakeProvider({
        turns: [turn({ text: 'ok' })],
        onCompleteTurn: (r) => seen.push(r),
      }),
    });
    const events: unknown[] = [];
    for await (const e of router.runAgentLoop({
      tier: 'bulk',
      messages: 'hi',
      maxIterations: 4,
      mcpTools,
      mcpClient: fakeMcpClient(),
    })) {
      events.push(e);
    }
    expect(seen[0]).toMatchObject({
      model: 'claude-sonnet-5',
      tools: mcpTools,
      messages: [{ role: 'user', content: 'hi' }],
      history: undefined,
      toolResults: [],
    });
  });

  it('meters exactly the usage events through onUsage, forwards tool_call/tool_result/text unchanged', async () => {
    const onUsage = vi.fn();
    const router = createRouter({
      provider: fakeProvider({
        turns: [
          turn({ toolCalls: [toolCall({ input: { query: 'x' } })] }),
          turn({ text: 'the answer' }),
        ],
      }),
      onUsage,
    });
    const events = [];
    for await (const e of router.runAgentLoop({
      messages: 'hi',
      maxIterations: 4,
      mcpTools,
      mcpClient: fakeMcpClient({ isError: false, content: [{ type: 'text', text: 'x' }] }),
    })) {
      events.push(e);
    }
    expect(events.map((e) => e.type)).toEqual([
      'tool_call',
      'tool_result',
      'usage',
      'text',
      'usage',
    ]);
    expect(onUsage).toHaveBeenCalledTimes(2);
    const usageEvents = events.filter(
      (e): e is { type: 'usage'; usage: UsageRecord } => e.type === 'usage',
    );
    expect(usageEvents[0]!.usage).toMatchObject({ model: 'claude-opus-5', inputTokens: 1000 });
  });

  it('executes tool calls against mcpClient and folds results + prior history into the next completeTurn call', async () => {
    const seen: ProviderTurnRequest[] = [];
    const mcpClient = fakeMcpClient({
      isError: false,
      content: [{ type: 'text', text: 'found it' }],
    });
    const turn1History = [{ role: 'user', content: 'seeded' }];
    const router = createRouter({
      provider: fakeProvider({
        turns: [
          turn({ toolCalls: [toolCall({ id: 'call-1' })], history: turn1History }),
          turn({ text: 'done' }),
        ],
        onCompleteTurn: (r) => seen.push(r),
      }),
    });
    for await (const _ of router.runAgentLoop({
      messages: 'hi',
      maxIterations: 4,
      mcpTools,
      mcpClient,
    })) {
      // drain
    }
    expect(mcpClient.callTool).toHaveBeenCalledWith({ name: 'search_context', arguments: {} });
    expect(seen[0]!.history).toBeUndefined(); // first turn — nothing to seed from yet
    expect(seen[1]!.history).toBe(turn1History); // exactly what turn 1 returned, threaded through opaquely
    expect(seen[1]!.toolResults).toEqual([
      {
        id: 'call-1',
        name: 'search_context',
        isError: false,
        content: [{ type: 'text', text: 'found it' }],
      },
    ]);
  });

  it('stops after maxIterations without a final turn, without throwing', async () => {
    const router = createRouter({
      provider: fakeProvider({
        turns: [turn({ toolCalls: [toolCall()] }), turn({ toolCalls: [toolCall()] })],
      }),
    });
    const events: unknown[] = [];
    for await (const e of router.runAgentLoop({
      messages: 'hi',
      maxIterations: 2,
      mcpTools,
      mcpClient: fakeMcpClient(),
    })) {
      events.push(e);
    }
    // Two full turns (tool_call, tool_result, usage each) — never a text event, never throws.
    expect(events.filter((e) => (e as { type: string }).type === 'usage')).toHaveLength(2);
    expect(events.some((e) => (e as { type: string }).type === 'text')).toBe(false);
  });

  it('the loop is provider-agnostic: two differently-shaped fake providers produce identical event sequences for the same script', async () => {
    const script: ProviderTurnResult[] = [
      turn({ toolCalls: [toolCall({ id: 'a', name: 'search_context', input: { q: 1 } })] }),
      turn({ text: 'final answer' }),
    ];

    // Provider A: opaque array history.
    const providerA = fakeProvider({ turns: script });
    // Provider B: a totally different internal history shape (an object, not an
    // array) — the router must not care, since `history` is opaque to it.
    const providerB: LlmProvider = {
      name: 'fake-b',
      zeroDataRetention: true,
      modelForTier: () => 'model-b',
      async complete() {
        return { text: 'unused', usage: USAGE };
      },
      async extract() {
        return { value: {}, usage: USAGE };
      },
      completeTurn: (() => {
        let i = 0;
        return async (r: ProviderTurnRequest) => {
          const result = script[i]!;
          i += 1;
          return { ...result, history: { turnsSoFar: i, seenToolResults: r.toolResults.length } };
        };
      })(),
    };

    async function run(provider: LlmProvider) {
      const events: unknown[] = [];
      const router = createRouter({ provider });
      for await (const e of router.runAgentLoop({
        messages: 'hi',
        maxIterations: 4,
        mcpTools,
        mcpClient: fakeMcpClient({ isError: false, content: [{ type: 'text', text: 'ok' }] }),
      })) {
        events.push({ ...(e as object), usage: undefined }); // usage carries provider/model — compare shape only
      }
      return events;
    }

    expect(await run(providerA)).toEqual(await run(providerB));
  });

  /**
   * Regression: `runAgentLoop` must invoke `completeTurn` bound to the
   * provider instance, not as a bare detached function. `OpenAiCompatibleProvider`
   * and `AnthropicProvider` both implement `completeTurn` as a real class
   * method reading instance state off `this` (`this.post`, `this.client`) —
   * `fakeProvider()`'s object-literal shape above doesn't exercise that at
   * all, since a plain object property never depends on its receiver. A class
   * instance does, so this is the shape that actually catches
   * `const completeTurn = provider.completeTurn; ...; completeTurn(...)`
   * silently losing `this` and throwing on the very first turn.
   */
  it('calls completeTurn bound to the provider instance, not detached', async () => {
    class ClassProvider implements LlmProvider {
      name = 'class-fake';
      zeroDataRetention = true;
      private readonly instanceState = 'bound';

      modelForTier(): string {
        return 'model-c';
      }
      async complete(): Promise<{ text: string; usage: ProviderTokenUsage }> {
        return { text: 'unused', usage: USAGE };
      }
      async extract(): Promise<{ value: unknown; usage: ProviderTokenUsage }> {
        return { value: {}, usage: USAGE };
      }
      async completeTurn(): Promise<ProviderTurnResult> {
        // Throws `Cannot read properties of undefined (reading 'instanceState')`
        // if called without `this` bound to a `ClassProvider` instance.
        if (this.instanceState !== 'bound') throw new Error('unreachable');
        return turn({ text: 'ok' });
      }
    }

    const router = createRouter({ provider: new ClassProvider() });
    const events: unknown[] = [];
    for await (const e of router.runAgentLoop({
      messages: 'hi',
      maxIterations: 4,
      mcpTools,
      mcpClient: fakeMcpClient(),
    })) {
      events.push(e);
    }
    expect(events.some((e) => (e as { type: string }).type === 'text')).toBe(true);
  });
});

describe('createRouter — ZDR enforcement', () => {
  it('exposes the provider posture; assertZeroDataRetention throws for a non-ZDR provider', () => {
    expect(createRouter({ provider: fakeProvider() }).zeroDataRetention).toBe(true);
    expect(() =>
      createRouter({ provider: fakeProvider() }).assertZeroDataRetention(),
    ).not.toThrow();

    const dev = createRouter({ provider: fakeProvider({ zeroDataRetention: false }) });
    expect(dev.zeroDataRetention).toBe(false);
    expect(() => dev.assertZeroDataRetention()).toThrow(DataRetentionError);
  });
});
