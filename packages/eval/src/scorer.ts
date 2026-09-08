import type { FactType } from '@fde/core';

import type { Fixture } from './fixtures.js';

/**
 * The slice of an extraction result the scorer reads. Structural, so both the
 * schema's input and output types satisfy it.
 */
export interface ScorableExtraction {
  facts: { type: FactType; evidence: { quote: string }[] }[];
}

export interface FixtureScore {
  id: string;
  /** Σ min(expected, actual) / Σ actual, over fact types */
  precision: number;
  /** Σ min(expected, actual) / Σ expected, over fact types */
  recall: number;
  /** fraction of expected key phrases found in some evidence quote */
  phraseRecall: number;
  detail: {
    countsByType: { type: FactType; expected: number; actual: number }[];
    phrases: { phrase: string; found: boolean }[];
  };
}

export interface Aggregate {
  precision: number;
  recall: number;
  phraseRecall: number;
}

/** Score one extraction result against its fixture. Pure — deterministic, no IO. */
export function scoreFixture(fixture: Fixture, result: ScorableExtraction): FixtureScore {
  const actualByType = new Map<string, number>();
  for (const fact of result.facts) {
    actualByType.set(fact.type, (actualByType.get(fact.type) ?? 0) + 1);
  }

  const types = new Set<string>([
    ...Object.keys(fixture.expected.factsByType),
    ...actualByType.keys(),
  ]);
  let truePositive = 0;
  let expectedTotal = 0;
  let actualTotal = 0;
  const countsByType: FixtureScore['detail']['countsByType'] = [];
  for (const type of types) {
    const expected = fixture.expected.factsByType[type as FactType] ?? 0;
    const actual = actualByType.get(type) ?? 0;
    truePositive += Math.min(expected, actual);
    expectedTotal += expected;
    actualTotal += actual;
    countsByType.push({ type: type as FactType, expected, actual });
  }

  const precision = actualTotal === 0 ? (expectedTotal === 0 ? 1 : 0) : truePositive / actualTotal;
  const recall = expectedTotal === 0 ? 1 : truePositive / expectedTotal;

  const quotes = result.facts.flatMap((f) => f.evidence.map((e) => e.quote.toLowerCase()));
  const phrases = fixture.expected.keyPhrases.map((phrase) => ({
    phrase,
    found: quotes.some((q) => q.includes(phrase.toLowerCase())),
  }));
  const phraseRecall =
    phrases.length === 0 ? 1 : phrases.filter((p) => p.found).length / phrases.length;

  return {
    id: fixture.id,
    precision,
    recall,
    phraseRecall,
    detail: { countsByType, phrases },
  };
}

/** Macro-average across fixtures. */
export function aggregate(scores: FixtureScore[]): Aggregate {
  if (scores.length === 0) return { precision: 0, recall: 0, phraseRecall: 0 };
  const mean = (pick: (s: FixtureScore) => number): number =>
    scores.reduce((sum, s) => sum + pick(s), 0) / scores.length;
  return {
    precision: mean((s) => s.precision),
    recall: mean((s) => s.recall),
    phraseRecall: mean((s) => s.phraseRecall),
  };
}
