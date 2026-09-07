import type { z } from 'zod';

import { createProviderFromEnv } from './env.js';
import { DataRetentionError, StructuredOutputError } from './errors.js';
import { computeChatCostUsd } from './pricing.js';
import type { LlmProvider, ProviderTokenUsage } from './provider.js';
import { getPrompt } from './prompts.js';
import type { ChatMessage, Effort, ThinkingMode, Tier, UsageRecord, UsageSink } from './types.js';

export interface PromptRef {
  name: string;
  version?: string;
}

export interface CompleteRequest {
  /** Routing tier. Default `'default'`. Ignored when `model` is set. */
  tier?: Tier;
  /** Explicit provider-native model id, overriding `tier`. */
  model?: string;
  /** Registry prompt for the system prompt; sets `promptVersion` on the `UsageRecord`. */
  prompt?: PromptRef;
  /** Ad-hoc system prompt (used only when `prompt` is absent). */
  system?: string;
  /** A single user turn (string) or a full transcript. */
  messages: string | ChatMessage[];
  maxTokens?: number;
  thinking?: ThinkingMode;
  effort?: Effort;
  stream?: boolean;
  signal?: AbortSignal;
}

export interface ExtractRequest extends Omit<CompleteRequest, 'stream'> {
  /** JSON Schema for the object the model must return. Defaults to a permissive object schema. */
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
}

export interface RouterConfig {
  provider?: LlmProvider;
  defaultTier?: Tier;
  defaultMaxTokens?: number;
  onUsage?: UsageSink;
  /** Injectable clock — tests pin latency. */
  now?: () => number;
}

export interface Router {
  readonly provider: LlmProvider;
  readonly zeroDataRetention: boolean;
  complete(request: CompleteRequest): Promise<{ text: string; usage: UsageRecord }>;
  extract<T>(
    schema: z.ZodType<T>,
    request: ExtractRequest,
  ): Promise<{ value: T; usage: UsageRecord }>;
  /** Throw unless the active provider carries a ZDR guarantee. Regulated engagements call this. */
  assertZeroDataRetention(): void;
}

export function createRouter(config: RouterConfig = {}): Router {
  const provider = config.provider ?? createProviderFromEnv();
  const now = config.now ?? Date.now;
  const defaultTier = config.defaultTier ?? 'default';
  const defaultMaxTokens = config.defaultMaxTokens ?? 16_000;

  function resolve(request: CompleteRequest | ExtractRequest) {
    const tier = request.tier ?? defaultTier;
    const model = request.model ?? provider.modelForTier(tier);
    const prompt = request.prompt ? getPrompt(request.prompt.name, request.prompt.version) : null;
    const messages: ChatMessage[] =
      typeof request.messages === 'string'
        ? [{ role: 'user', content: request.messages }]
        : request.messages;
    return {
      tier,
      model,
      system: prompt?.system ?? request.system,
      promptVersion: prompt?.version ?? null,
      messages,
    };
  }

  function record(
    model: string,
    tier: Tier,
    promptVersion: string | null,
    usage: ProviderTokenUsage,
    latencyMs: number,
  ): UsageRecord {
    const { costUsd, pricedFrom } = computeChatCostUsd(model, usage);
    return {
      provider: provider.name,
      model,
      tier,
      promptVersion,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      costUsd,
      pricedFrom,
      latencyMs,
    };
  }

  const emit = (r: UsageRecord) => Promise.resolve(config.onUsage?.(r));

  return {
    provider,
    get zeroDataRetention() {
      return provider.zeroDataRetention;
    },
    assertZeroDataRetention() {
      if (!provider.zeroDataRetention) throw new DataRetentionError();
    },

    async complete(request) {
      const { tier, model, system, promptVersion, messages } = resolve(request);
      const start = now();
      const result = await provider.complete({
        model,
        system,
        messages,
        maxTokens: request.maxTokens ?? defaultMaxTokens,
        thinking: request.thinking ?? 'adaptive',
        effort: request.effort,
        stream: request.stream,
        signal: request.signal,
      });
      const usage = record(model, tier, promptVersion, result.usage, now() - start);
      await emit(usage);
      return { text: result.text, usage };
    },

    async extract(schema, request) {
      const { tier, model, system, promptVersion, messages } = resolve(request);
      const start = now();
      const result = await provider.extract({
        model,
        system,
        messages,
        maxTokens: request.maxTokens ?? defaultMaxTokens,
        thinking: request.thinking ?? 'adaptive',
        effort: request.effort,
        signal: request.signal,
        jsonSchema: request.jsonSchema ?? { type: 'object', additionalProperties: true },
        schemaName: request.schemaName ?? 'record_result',
      });
      // Emit before validating: the call was made and billed regardless of
      // whether the model's output parses, and the sink must see that cost.
      const usage = record(model, tier, promptVersion, result.usage, now() - start);
      await emit(usage);

      const parsed = schema.safeParse(result.value);
      if (!parsed.success) {
        throw new StructuredOutputError(
          'model output failed schema validation',
          parsed.error.issues,
        );
      }
      return { value: parsed.data, usage };
    },
  };
}
