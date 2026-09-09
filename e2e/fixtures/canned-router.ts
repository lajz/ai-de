import type { ExtractionResult, Router } from '@fde/llm';

import { EXPECTED_FACTS, spanOf } from './meeting-transcript.js';

/**
 * A deterministic stand-in for the Claude extraction router, built from
 * {@link EXPECTED_FACTS}. `runExtractionActivity` calls `router.extract()` once
 * per transcript chunk; the fixture transcript is a single chunk, so this
 * returns the whole expected fact set on the first call and nothing on any
 * subsequent call (guards against a chunk boundary sneaking in and duplicating
 * facts).
 *
 * Char spans are computed against the full rendered transcript. The activity
 * re-verifies every span verbatim against the source before storing it, so a
 * drifted fixture surfaces as an unlocatable span, not a false citation.
 *
 * Real-LLM extraction is covered by `@fde/eval`; wiring a real router here would
 * make the pipeline assertions non-deterministic for no extra coverage.
 */
export function createCannedExtractionRouter(costUsdPerCall = 0.0011): Router {
  let call = 0;

  const result = (): ExtractionResult => {
    if (call++ > 0) return { facts: [] };
    return {
      facts: EXPECTED_FACTS.map((f) => {
        const { charStart, charEnd } = spanOf(f.quote);
        return {
          type: f.type,
          summary: `${f.summaryPhrase} — ${f.detail.slice(0, 60)}`,
          detail: f.detail,
          confidence: 0.9,
          evidence: [{ quote: f.quote, charStart, charEnd, relation: 'supports' as const }],
        };
      }),
    } as ExtractionResult;
  };

  const unused = () => {
    throw new Error(
      'createCannedExtractionRouter: complete() is not used by the extraction pipeline',
    );
  };

  return {
    provider: {
      name: 'canned-e2e',
      zeroDataRetention: true,
      modelForTier: () => 'claude-sonnet-5',
    },
    zeroDataRetention: true,
    assertZeroDataRetention() {},
    complete: unused,
    async extract() {
      return { value: result(), usage: { costUsd: costUsdPerCall } };
    },
  } as unknown as Router;
}
