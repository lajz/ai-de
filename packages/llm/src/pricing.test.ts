import { describe, expect, it } from 'vitest';

import { UnknownModelError } from './errors.js';
import { computeChatCostUsd, computeEmbeddingCostUsd, MODEL_RATES } from './pricing.js';

describe('computeChatCostUsd', () => {
  it('sums input, output, and cache tokens at the model rate', () => {
    const { costUsd, pricedFrom } = computeChatCostUsd('claude-opus-5', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      cacheCreationInputTokens: 1_000_000,
    });
    const r = MODEL_RATES['claude-opus-5']!;
    expect(costUsd).toBeCloseTo(
      r.inputPerMTok + r.outputPerMTok + r.cacheReadPerMTok + r.cacheWritePerMTok,
      10,
    );
    expect(pricedFrom).toBe('claude-opus-5');
  });

  it('treats missing cache counts as zero', () => {
    const { costUsd } = computeChatCostUsd('claude-sonnet-5', {
      inputTokens: 500_000,
      outputTokens: 0,
    });
    expect(costUsd).toBeCloseTo((500_000 * 2) / 1_000_000, 10);
  });

  it('returns cost 0 / pricedFrom null for an unpriced model', () => {
    expect(computeChatCostUsd('llama-local', { inputTokens: 10, outputTokens: 10 })).toEqual({
      costUsd: 0,
      pricedFrom: null,
    });
  });
});

describe('computeEmbeddingCostUsd', () => {
  it('prices Voyage tokens', () => {
    expect(computeEmbeddingCostUsd('voyage-3.5', 1_000_000)).toBeCloseTo(0.06, 10);
  });

  it('throws UnknownModelError for an unknown embedding model', () => {
    expect(() => computeEmbeddingCostUsd('bge-local', 100)).toThrow(UnknownModelError);
  });
});
