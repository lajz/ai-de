import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { DataRetentionError, StructuredOutputError } from './errors.js';
import type {
  LlmProvider,
  ProviderCompleteRequest,
  ProviderExtractRequest,
  ProviderTokenUsage,
} from './providers/types.js';
import { createRouter } from './router.js';
import type { Tier, UsageRecord } from './types.js';

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

function fakeProvider(opts: FakeOpts = {}): LlmProvider {
  return {
    name: 'fake',
    zeroDataRetention: opts.zeroDataRetention ?? true,
    modelForTier: (tier: Tier) => (tier === 'bulk' ? 'claude-sonnet-5' : 'claude-opus-5'),
    async complete(request) {
      opts.onComplete?.(request);
      return { text: opts.completeText ?? 'ok', usage: USAGE };
    },
    async extract(request) {
      opts.onExtract?.(request);
      return { value: opts.extractValue ?? { facts: [] }, usage: USAGE };
    },
  };
}

describe('createRouter — routing', () => {
  it('maps tier → model and defaults to the "default" tier', async () => {
    const seen: ProviderCompleteRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onComplete: (r) => seen.push(r) }) });

    await router.complete({ messages: 'hi' });
    await router.complete({ tier: 'bulk', messages: 'hi' });

    expect(seen[0]!.model).toBe('claude-opus-5');
    expect(seen[1]!.model).toBe('claude-sonnet-5');
  });

  it('an explicit model overrides the tier', async () => {
    const seen: ProviderCompleteRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onComplete: (r) => seen.push(r) }) });
    await router.complete({ tier: 'bulk', model: 'claude-opus-5', messages: 'hi' });
    expect(seen[0]!.model).toBe('claude-opus-5');
  });

  it('resolves a registry prompt into the system prompt + promptVersion', async () => {
    const seen: ProviderCompleteRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onComplete: (r) => seen.push(r) }) });
    const { usage } = await router.complete({
      prompt: { name: 'extraction' },
      messages: 'chunk',
    });
    expect(seen[0]!.system).toContain('You extract a structured record');
    expect(usage.promptVersion).toBe('2026-02-14');
  });

  it('defaults thinking to adaptive', async () => {
    const seen: ProviderCompleteRequest[] = [];
    const router = createRouter({ provider: fakeProvider({ onComplete: (r) => seen.push(r) }) });
    await router.complete({ messages: 'hi' });
    expect(seen[0]!.thinking).toBe('adaptive');
  });
});

describe('createRouter — UsageRecord', () => {
  it('has exactly the allowed keys and prices from the model rate table', async () => {
    let record: UsageRecord | undefined;
    const router = createRouter({
      provider: fakeProvider(),
      now: (() => {
        let t = 1000;
        return () => (t += 50);
      })(),
      onUsage: (r) => {
        record = r;
      },
    });

    const { usage } = await router.complete({ messages: 'hi' });
    expect(record).toEqual(usage); // sink fired with the same record
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
    // claude-opus-5: (1000 * 5 + 200 * 25) / 1e6
    expect(usage.costUsd).toBeCloseTo((1000 * 5 + 200 * 25) / 1_000_000, 10);
    expect(usage.pricedFrom).toBe('claude-opus-5');
    expect(usage.latencyMs).toBe(50);
  });

  it('an unpriced model costs 0 and reports pricedFrom: null', async () => {
    const router = createRouter({ provider: fakeProvider() });
    const { usage } = await router.complete({ model: 'some-local-model', messages: 'hi' });
    expect(usage.costUsd).toBe(0);
    expect(usage.pricedFrom).toBeNull();
  });

  it('never carries prompt or response text', async () => {
    const secret = 'CANARY-6f2a-transcript-body';
    let record: UsageRecord | undefined;
    const router = createRouter({
      provider: fakeProvider({ completeText: `... ${secret} ...` }),
      onUsage: (r) => {
        record = r;
      },
    });
    await router.complete({ system: `system ${secret}`, messages: `user ${secret}` });
    expect(JSON.stringify(record)).not.toContain(secret);
  });

  it('calls onUsage for extract() too', async () => {
    const onUsage = vi.fn();
    const router = createRouter({ provider: fakeProvider(), onUsage });
    await router.extract(z.object({ facts: z.array(z.unknown()) }), { messages: 'x' });
    expect(onUsage).toHaveBeenCalledOnce();
  });
});

describe('createRouter — extract validation', () => {
  const schema = z.object({ facts: z.array(z.object({ type: z.string() })) });

  it('returns the parsed value on a valid response', async () => {
    const router = createRouter({
      provider: fakeProvider({ extractValue: { facts: [{ type: 'decision' }] } }),
    });
    const { value } = await router.extract(schema, { messages: 'x' });
    expect(value).toEqual({ facts: [{ type: 'decision' }] });
  });

  it('throws StructuredOutputError (with issues) on a malformed response', async () => {
    const router = createRouter({
      provider: fakeProvider({ extractValue: { facts: [{ nope: true }] } }),
    });
    await expect(router.extract(schema, { messages: 'x' })).rejects.toThrow(StructuredOutputError);
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
  it('exposes the provider ZDR posture', () => {
    expect(
      createRouter({ provider: fakeProvider({ zeroDataRetention: true }) }).zeroDataRetention,
    ).toBe(true);
    expect(
      createRouter({ provider: fakeProvider({ zeroDataRetention: false }) }).zeroDataRetention,
    ).toBe(false);
  });

  it('assertZeroDataRetention throws for a non-ZDR provider', () => {
    const zdr = createRouter({ provider: fakeProvider({ zeroDataRetention: true }) });
    expect(() => zdr.assertZeroDataRetention()).not.toThrow();

    const dev = createRouter({ provider: fakeProvider({ zeroDataRetention: false }) });
    expect(() => dev.assertZeroDataRetention()).toThrow(DataRetentionError);
  });
});
