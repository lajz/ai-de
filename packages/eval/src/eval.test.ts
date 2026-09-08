import { describe, expect, it, vi } from 'vitest';

import { StructuredOutputError, type ExtractionResult, type Router } from '@fde/llm';

import { gate, type Baseline } from './baseline.js';
import { loadFixtures, type Fixture } from './fixtures.js';
import { runEval } from './runner.js';
import { aggregate, scoreFixture } from './scorer.js';

const fixture: Fixture = {
  id: 'unit',
  chunk: 'irrelevant — the scorer never calls a model',
  expected: {
    factsByType: { decision: 1, commitment: 1 },
    keyPhrases: ['ship on Friday', 'send the SOW'],
  },
};

const result = (facts: ExtractionResult['facts']): ExtractionResult => ({ facts });

describe('scoreFixture', () => {
  it('scores a perfect extraction 1/1/1', () => {
    const s = scoreFixture(
      fixture,
      result([
        {
          type: 'decision',
          summary: 'ship Friday',
          confidence: 0.9,
          evidence: [{ quote: "We'll ship on Friday.", relation: 'supports' }],
        },
        {
          type: 'commitment',
          summary: 'SOW',
          confidence: 0.8,
          evidence: [{ quote: "I'll send the SOW Thursday.", relation: 'supports' }],
        },
      ]),
    );
    expect([s.precision, s.recall, s.phraseRecall]).toEqual([1, 1, 1]);
  });

  it('penalises a spurious extra fact (precision) and a missed phrase (phraseRecall)', () => {
    const s = scoreFixture(
      fixture,
      result([
        {
          type: 'decision',
          summary: 'ship Friday',
          confidence: 0.9,
          evidence: [{ quote: 'We ship on Friday.', relation: 'supports' }],
        },
        {
          type: 'commitment',
          summary: 'SOW',
          confidence: 0.8,
          evidence: [{ quote: 'Bob will handle the paperwork.', relation: 'supports' }],
        },
        {
          type: 'risk',
          summary: 'unexpected',
          confidence: 0.5,
          evidence: [{ quote: 'migration might slip.', relation: 'supports' }],
        },
      ]),
    );
    expect(s.recall).toBe(1); // both expected types present
    expect(s.precision).toBeCloseTo(2 / 3, 5); // 3 facts, 2 match expected counts
    expect(s.phraseRecall).toBe(0.5); // "send the SOW" not quoted
  });

  it('recall drops when a type is missing entirely', () => {
    const s = scoreFixture(
      fixture,
      result([
        {
          type: 'decision',
          summary: 'ship Friday',
          confidence: 0.9,
          evidence: [{ quote: 'ship on Friday', relation: 'supports' }],
        },
      ]),
    );
    expect(s.recall).toBe(0.5);
    expect(s.precision).toBe(1);
  });
});

describe('aggregate', () => {
  it('macro-averages across fixtures', () => {
    expect(
      aggregate([
        {
          id: 'a',
          precision: 1,
          recall: 1,
          phraseRecall: 1,
          detail: { countsByType: [], phrases: [] },
        },
        {
          id: 'b',
          precision: 0,
          recall: 0.5,
          phraseRecall: 0,
          detail: { countsByType: [], phrases: [] },
        },
      ]),
    ).toEqual({ precision: 0.5, recall: 0.75, phraseRecall: 0.5 });
  });
});

describe('gate', () => {
  const baseline = (over: Partial<Baseline> = {}): Baseline => ({
    promptVersion: '2026-02-14',
    model: 'claude-sonnet-5',
    seed: false,
    aggregate: { precision: 0.8, recall: 0.8, phraseRecall: 0.8 },
    recordedAt: '2026-09-08T00:00:00.000Z',
    ...over,
  });

  it('passes within epsilon and fails a real regression', () => {
    expect(gate({ precision: 0.78, recall: 0.8, phraseRecall: 0.82 }, baseline()).ok).toBe(true);
    const bad = gate({ precision: 0.6, recall: 0.8, phraseRecall: 0.8 }, baseline());
    expect(bad.ok).toBe(false);
    expect(bad.regressions).toEqual([{ metric: 'precision', baseline: 0.8, current: 0.6 }]);
  });

  it('treats a missing or seed baseline as informational', () => {
    expect(gate({ precision: 0, recall: 0, phraseRecall: 0 }, null)).toMatchObject({
      ok: true,
      informational: true,
    });
    expect(
      gate({ precision: 0, recall: 0, phraseRecall: 0 }, baseline({ seed: true })).informational,
    ).toBe(true);
  });
});

describe('runEval', () => {
  const fixtures: Fixture[] = [
    { id: 'a', chunk: 'x', expected: { factsByType: { decision: 1 }, keyPhrases: ['ship'] } },
    { id: 'b', chunk: 'y', expected: { factsByType: { risk: 1 }, keyPhrases: ['slip'] } },
  ];
  const fakeRouter = (extract: Router['extract']): Router =>
    ({ provider: { modelForTier: () => 'fake-bulk' }, extract }) as unknown as Router;

  it('scores each fixture and reports the model from usage', async () => {
    const router = fakeRouter(
      async () =>
        ({
          value: {
            facts: [{ type: 'decision', evidence: [{ quote: 'we ship now' }] }],
          } as ExtractionResult,
          usage: { model: 'claude-sonnet-5' },
        }) as Awaited<ReturnType<Router['extract']>>,
    );
    const report = await runEval({ router, fixtures });
    expect(report.model).toBe('claude-sonnet-5');
    expect(report.perFixture).toHaveLength(2);
    expect(report.perFixture[0]!.recall).toBe(1); // decision found
    expect(report.perFixture[1]!.recall).toBe(0); // risk missing
  });

  it('scores a failing fixture zero and keeps going', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let call = 0;
    const router = fakeRouter(async () => {
      if (call++ === 0) throw new StructuredOutputError('bad', undefined);
      return {
        value: {
          facts: [{ type: 'risk', evidence: [{ quote: 'it will slip' }] }],
        } as ExtractionResult,
        usage: { model: 'm' },
      } as Awaited<ReturnType<Router['extract']>>;
    });
    const report = await runEval({ router, fixtures });
    expect(report.perFixture).toHaveLength(2);
    expect(report.perFixture[0]!.recall).toBe(0); // the thrown fixture
    expect(report.perFixture[1]!.phraseRecall).toBe(1);
  });
});

describe('committed fixtures', () => {
  it('load and validate, with enough labelled examples', () => {
    const fixtures = loadFixtures();
    expect(fixtures.length).toBeGreaterThanOrEqual(3);
    const withFacts = fixtures.filter((f) => Object.keys(f.expected.factsByType).length > 0);
    expect(withFacts.length).toBeGreaterThanOrEqual(3);
    for (const f of withFacts) expect(f.expected.keyPhrases.length).toBeGreaterThan(0);
  });
});
