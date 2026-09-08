import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createTracerFromEnv,
  LangfuseTracer,
  NoopTracer,
  redactUsage,
  type LangfuseClientLike,
  type UsageRecord,
} from './index.js';

const usage: UsageRecord = {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tier: 'bulk',
  promptVersion: '2026-02-14',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0.001,
  pricedFrom: 'claude-sonnet-5',
  latencyMs: 500,
};

/** A fake Langfuse client — records bodies, flushes on demand, optionally throws. */
function fakeClient(opts: { throwOn?: 'trace' | 'generation' | 'flush' } = {}) {
  const generations: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const traces: Record<string, unknown>[] = [];
  let flushes = 0;
  let shutdowns = 0;
  const client: LangfuseClientLike = {
    trace(body) {
      if (opts.throwOn === 'trace') throw new Error('boom');
      traces.push(body);
      return {
        generation(g) {
          if (opts.throwOn === 'generation') throw new Error('boom');
          generations.push(g);
          return undefined;
        },
        update(u) {
          updates.push(u);
          return undefined;
        },
      };
    },
    async flushAsync() {
      if (opts.throwOn === 'flush') throw new Error('boom');
      flushes += 1;
    },
    async shutdownAsync() {
      shutdowns += 1;
    },
  };
  return {
    client,
    generations,
    updates,
    traces,
    get flushes() {
      return flushes;
    },
    get shutdowns() {
      return shutdowns;
    },
  };
}

afterEach(() => {
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_BASE_URL;
  vi.restoreAllMocks();
});

describe('LangfuseTracer', () => {
  it('emits redacted generations, does not flush per event, and flushes on shutdown', async () => {
    const fake = fakeClient();
    const tracer = new LangfuseTracer({ client: fake.client });

    const trace = tracer.startTrace({ name: 'extraction.run', extractionRunId: 'r1' });
    trace.generation(redactUsage(usage, { name: 'extraction.chunk', outcome: 'ok' }));
    trace.generation(redactUsage(usage, { name: 'extraction.chunk', outcome: 'ok' }));
    trace.end({ factCount: 3 });

    expect(fake.traces[0]).toMatchObject({
      name: 'extraction.run',
      metadata: { extractionRunId: 'r1' },
    });
    expect(fake.generations).toHaveLength(2);
    expect(fake.generations[0]).toMatchObject({
      model: 'claude-sonnet-5',
      usageDetails: { input: 100, output: 20 },
      metadata: { outcome: 'ok', provider: 'anthropic' },
    });
    expect(fake.updates[0]).toMatchObject({ metadata: { factCount: 3 } });
    expect(fake.flushes).toBe(0); // batched — no flush until asked

    await tracer.shutdown();
    expect(fake.shutdowns).toBe(1);
  });

  it('swallows transport errors from trace(), generation(), and flush()', async () => {
    for (const throwOn of ['trace', 'generation', 'flush'] as const) {
      const fake = fakeClient({ throwOn });
      const tracer = new LangfuseTracer({ client: fake.client });
      const trace = tracer.startTrace({ name: 'extraction.run' });
      expect(() =>
        trace.generation(redactUsage(usage, { name: 'c', outcome: 'ok' })),
      ).not.toThrow();
      expect(() => trace.end({ factCount: 1 })).not.toThrow();
      await expect(tracer.flush()).resolves.toBeUndefined();
    }
  });

  it('refuses a payload that fails the redaction boundary — nothing reaches the client', () => {
    const fake = fakeClient();
    const tracer = new LangfuseTracer({
      client: fake.client,
      redactionCanaries: ['CANARY'],
    });
    const trace = tracer.startTrace({ name: 'extraction.run' });
    // A caller mis-builds a generation with content in an allowed field.
    trace.generation({
      ...redactUsage(usage, { name: 'extraction.chunk', outcome: 'ok' }),
      promptVersion: 'leaked CANARY text',
    });
    expect(fake.generations).toHaveLength(0);
  });

  it('bounds the open-trace queue', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = fakeClient();
    const tracer = new LangfuseTracer({ client: fake.client, maxOpenTraces: 2 });
    tracer.startTrace({ name: 'extraction.run' });
    tracer.startTrace({ name: 'extraction.run' });
    tracer.startTrace({ name: 'extraction.run' }); // dropped
    expect(fake.traces).toHaveLength(2);
  });
});

describe('createTracerFromEnv', () => {
  it('returns NoopTracer with no keys, LangfuseTracer with both, and warns once on a lone key', () => {
    expect(createTracerFromEnv({})).toBeInstanceOf(NoopTracer);

    expect(
      createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' }),
    ).toBeInstanceOf(LangfuseTracer);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: 'pk' });
    createTracerFromEnv({ LANGFUSE_PUBLIC_KEY: 'pk' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).not.toContain('pk');
  });
});
