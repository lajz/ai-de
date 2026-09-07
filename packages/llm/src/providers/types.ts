import type { ChatMessage, Effort, ThinkingMode, Tier } from '../types.js';

export interface ProviderCompleteRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  thinking: ThinkingMode;
  effort?: Effort;
  /** Hint that the call may be long — providers that can should stream and coalesce. */
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface ProviderCompleteResult {
  text: string;
  usage: ProviderTokenUsage;
}

export interface ProviderExtractRequest extends Omit<ProviderCompleteRequest, 'stream'> {
  /** JSON Schema (draft 2020-12) for the object the model must return. */
  jsonSchema: Record<string, unknown>;
  /** Name for the schema / tool — surfaced to the model. */
  schemaName: string;
}

export interface ProviderExtractResult {
  /** Parsed JSON object, NOT yet validated against the caller's Zod schema. */
  value: unknown;
  usage: ProviderTokenUsage;
}

/**
 * A model backend. `AnthropicProvider` is production (Claude + ZDR);
 * `OpenAiCompatibleProvider` is the dev/CI seam (DeepSeek, Ollama).
 */
export interface LlmProvider {
  readonly name: string;
  /**
   * Whether calls to this provider carry a Zero Data Retention guarantee. `false`
   * means dev/CI only — never regulated content. The router exposes this and
   * `assertZeroDataRetention()` for callers that must enforce it per engagement.
   */
  readonly zeroDataRetention: boolean;
  /** Concrete model id for a routing tier. */
  modelForTier(tier: Tier): string;
  complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResult>;
  extract(request: ProviderExtractRequest): Promise<ProviderExtractResult>;
}

export const EMPTY_USAGE: ProviderTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
