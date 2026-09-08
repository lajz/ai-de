import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  DataRetentionError,
  StructuredOutputError,
  createRouter,
  type LlmProvider,
  type ProviderCompleteRequest,
  type ProviderExtractRequest,
  type ProviderTokenUsage,
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
}

function fakeProvider(o: FakeOpts = {}): LlmProvider {
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
  };
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
