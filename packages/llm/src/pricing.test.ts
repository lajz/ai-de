import { describe, expect, it } from 'vitest';

import {
  MODEL_RATES,
  UnknownModelError,
  computeChatCostUsd,
  computeEmbeddingCostUsd,
} from './index.js';

describe('computeChatCostUsd', () => {
  it('sums input, output, and cache tokens at the model rate', () => {
    const r = MODEL_RATES['claude-opus-5']!;
    const { costUsd, pricedFrom } = computeChatCostUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    });
    expect(costUsd).toBeCloseTo(
      r.inputPerMTok + r.outputPerMTok + r.cacheReadPerMTok + r.cacheWritePerMTok,
      10,
    );
    expect(pricedFrom).toBe('claude-opus-5');
  });

  it('treats missing cache counts as zero and returns 0 / null for an unpriced model', () => {
    expect(
      computeChatCostUsd('claude-sonnet-5', { inputTokens: 500_000, outputTokens: 0 }).costUsd,
    ).toBeCloseTo(1, 10);
    expect(computeChatCostUsd('llama-local', { inputTokens: 10, outputTokens: 10 })).toEqual({
      costUsd: 0,
      pricedFrom: null,
    });
  });
});

describe('computeEmbeddingCostUsd', () => {
  it('prices Voyage tokens and throws for an unknown model', () => {
    expect(computeEmbeddingCostUsd('voyage-3.5', 1_000_000)).toBeCloseTo(0.06, 10);
    expect(() => computeEmbeddingCostUsd('bge-local', 100)).toThrow(UnknownModelError);
  });
});
