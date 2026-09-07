import { UnknownModelError } from './errors.js';

/** USD per 1M tokens. Keep flat and boring — this is the one place to edit rates. */
export interface ModelRate {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cost of writing the prompt-cache entry (Anthropic ~1.25× input). */
  cacheWritePerMTok: number;
  /** Cost of a prompt-cache read (Anthropic ~0.1× input). */
  cacheReadPerMTok: number;
}

/**
 * Chat-model rates. Anthropic first-party rates from `claude-api` skill
 * (cached 2026-06-24). DeepSeek rates are estimates for the dev/CI provider —
 * confirm at https://platform.deepseek.com/pricing before relying on the cost
 * numbers for anything but rough tracking.
 */
export const MODEL_RATES: Record<string, ModelRate> = {
  'claude-opus-5': {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheWritePerMTok: 6.25,
    cacheReadPerMTok: 0.5,
  },
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWritePerMTok: 2.5,
    cacheReadPerMTok: 0.2,
  },
  // --- dev/CI only (OpenAiCompatibleProvider); estimates ---
  'deepseek-v4-flash': {
    inputPerMTok: 0.28,
    outputPerMTok: 0.42,
    cacheWritePerMTok: 0.28,
    cacheReadPerMTok: 0.028,
  },
  'deepseek-v4': {
    inputPerMTok: 0.55,
    outputPerMTok: 2.19,
    cacheWritePerMTok: 0.55,
    cacheReadPerMTok: 0.055,
  },
};

/** Embedding-model rates. USD per 1M tokens. */
export interface EmbeddingRate {
  perMTok: number;
}

export const EMBEDDING_RATES: Record<string, EmbeddingRate> = {
  // Voyage AI (T0 embeddings). https://docs.voyageai.com/docs/pricing
  'voyage-3.5': { perMTok: 0.06 },
  'voyage-3.5-lite': { perMTok: 0.02 },
  'voyage-3-large': { perMTok: 0.18 },
};

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface CostResult {
  costUsd: number;
  /** The `MODEL_RATES` key used, or `null` if the model has no entry (cost is 0). */
  pricedFrom: string | null;
}

/** Cost of one chat completion. Unknown models cost 0 and report `pricedFrom: null`. */
export function computeChatCostUsd(model: string, tokens: TokenCounts): CostResult {
  const rate = MODEL_RATES[model];
  if (!rate) return { costUsd: 0, pricedFrom: null };
  const cacheRead = tokens.cacheReadInputTokens ?? 0;
  const cacheWrite = tokens.cacheCreationInputTokens ?? 0;
  const costUsd =
    (tokens.inputTokens * rate.inputPerMTok +
      tokens.outputTokens * rate.outputPerMTok +
      cacheRead * rate.cacheReadPerMTok +
      cacheWrite * rate.cacheWritePerMTok) /
    1_000_000;
  return { costUsd, pricedFrom: model };
}

/** Cost of embedding `tokenCount` tokens with `model`. Throws on an unknown model — embedding callers pin the model. */
export function computeEmbeddingCostUsd(model: string, tokenCount: number): number {
  const rate = EMBEDDING_RATES[model];
  if (!rate) throw new UnknownModelError(model);
  return (tokenCount * rate.perMTok) / 1_000_000;
}
