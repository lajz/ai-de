import { describe, expect, it } from 'vitest';

import {
  assertRedacted,
  FakeTracer,
  NoopTracer,
  RedactionError,
  redactUsage,
  sha256Hex,
  traceExtraction,
  tracingUsageSink,
  type UsageRecord,
} from './index.js';

const CANARY = 'CANARY-transcript-body-do-not-log';

const usage = (over: Partial<UsageRecord> = {}): UsageRecord => ({
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tier: 'bulk',
  promptVersion: '2026-02-14',
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0.0031,
  pricedFrom: 'claude-sonnet-5',
  latencyMs: 900,
  ...over,
});

describe('assertRedacted — the redaction boundary', () => {
  it('accepts a metadata-only payload and rejects unknown keys, long strings, and canaries', () => {
    expect(() =>
      assertRedacted({ name: 'extraction.chunk', model: 'claude-sonnet-5', inputTokens: 10 }),
    ).not.toThrow();

    expect(() => assertRedacted({ transcript: 'hi' })).toThrow(RedactionError);
    expect(() => assertRedacted({ promptVersion: 'x'.repeat(200) })).toThrow(/exceeds/);
    expect(() => assertRedacted({ name: 'a sentence, not a label' })).toThrow(/label/);
    expect(() => assertRedacted({ promptVersion: `v ${CANARY}` }, [CANARY])).toThrow(/forbidden/);
    expect(() => assertRedacted({ name: 'ok', model: { nested: 1 } })).toThrow(/allowlist|scalar/i);
  });
});

describe('redactUsage + tracingUsageSink', () => {
  it('turns a UsageRecord into a generation carrying only the allowed fields', () => {
    const gen = redactUsage(usage(), { name: 'llm.generation', outcome: 'ok' });
    expect(() => assertRedacted(gen)).not.toThrow();
    expect(gen).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.0031,
      latencyMs: 900,
      outcome: 'ok',
    });
    // `pricedFrom` is not carried onto the span.
    expect(Object.keys(gen)).not.toContain('pricedFrom');
  });

  it('sink emits a standalone trace when no run is active', () => {
    const tracer = new FakeTracer();
    tracingUsageSink(tracer)(usage());
    expect(tracer.traces).toHaveLength(1);
    expect(tracer.traces[0]!.input.name).toBe('llm.call');
    expect(tracer.traces[0]!.generations[0]!.model).toBe('claude-sonnet-5');
    expect(tracer.traces[0]!.ended).toBe(true);
  });

  it('sink stays out of the way inside a traceExtraction scope', async () => {
    const tracer = new FakeTracer();
    const sink = tracingUsageSink(tracer);
    await traceExtraction(
      tracer,
      { extractionRunId: 'run-1', sourceId: 'src-1' },
      async (trace) => {
        sink(usage()); // would double-record if the sink didn't defer to the active run
        trace.generation(redactUsage(usage(), { name: 'extraction.chunk', outcome: 'ok' }));
        trace.end({ factCount: 2, okChunks: 1 });
      },
    );
    expect(tracer.traces).toHaveLength(1);
    expect(tracer.traces[0]!.input).toMatchObject({
      name: 'extraction.run',
      extractionRunId: 'run-1',
    });
    expect(tracer.traces[0]!.generations).toHaveLength(1);
    expect(tracer.traces[0]!.end).toMatchObject({ factCount: 2, okChunks: 1 });
  });

  it('traceExtraction closes the trace even if fn never calls end()', async () => {
    const tracer = new FakeTracer();
    await traceExtraction(tracer, { extractionRunId: 'r' }, async () => {});
    expect(tracer.traces[0]!.ended).toBe(true);
  });
});

describe('canary — no prompt/output text can reach the tracer', () => {
  it('a run whose prompt + response carry the canary records only content-free spans', async () => {
    const tracer = new FakeTracer();
    // Simulate the router's onUsage stream: content-free records only.
    await traceExtraction(tracer, { extractionRunId: 'run', sourceId: 'src' }, async (trace) => {
      trace.generation(
        redactUsage(usage(), {
          name: 'extraction.chunk',
          outcome: 'ok',
          inputHash: sha256Hex(`Alice: ${CANARY}`),
        }),
      );
      trace.end({ factCount: 1 });
    });
    const dump = JSON.stringify(tracer.traces);
    expect(dump).not.toContain(CANARY);
    for (const gen of tracer.generations) expect(() => assertRedacted(gen, [CANARY])).not.toThrow();
  });
});

describe('NoopTracer', () => {
  it('records nothing and never throws', async () => {
    const t = new NoopTracer();
    const h = t.startTrace({ name: 'x' });
    h.generation(redactUsage(usage(), { name: 'g', outcome: 'ok' }));
    h.end({ factCount: 1 });
    await t.flush();
    await t.shutdown();
  });
});
