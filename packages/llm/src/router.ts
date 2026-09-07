import type { z } from 'zod';

import { DataRetentionError, StructuredOutputError } from './errors.js';
import { getPrompt } from './prompts/registry.js';
import { computeChatCostUsd } from './pricing.js';
import { createProviderFromEnv } from './providers/from-env.js';
import type { LlmProvider, ProviderTokenUsage } from './providers/types.js';
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
  /** Registry prompt to use as the system prompt; sets `promptVersion` on the `UsageRecord`. */
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

export interface CompleteResult {
  text: string;
  usage: UsageRecord;
}

export interface ExtractRequest extends Omit<CompleteRequest, 'stream'> {
  /** JSON Schema for the object the model must return. Defaults to a permissive object schema. */
  jsonSchema?: Record<string, unknown>;
  schemaName?: string;
}

export interface ExtractResult<T> {
  value: T;
  usage: UsageRecord;
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
  complete(request: CompleteRequest): Promise<CompleteResult>;
  extract<T>(schema: z.ZodType<T>, request: ExtractRequest): Promise<ExtractResult<T>>;
  /** Throw unless the active provider carries a ZDR guarantee. Regulated engagements call this. */
  assertZeroDataRetention(): void;
}

const DEFAULT_MAX_TOKENS = 16_000;

export function createRouter(config: RouterConfig = {}): Router {
  const provider = config.provider ?? createProviderFromEnv();
  const now = config.now ?? Date.now;
  const defaultTier = config.defaultTier ?? 'default';
  const defaultMaxTokens = config.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;

  function resolve(request: CompleteRequest | ExtractRequest): {
    tier: Tier;
    model: string;
    system: string | undefined;
    promptVersion: string | null;
    messages: ChatMessage[];
  } {
    const tier = request.tier ?? defaultTier;
    const model = request.model ?? provider.modelForTier(tier);
    let system = request.system;
    let promptVersion: string | null = null;
    if (request.prompt) {
      const resolved = getPrompt(request.prompt.name, request.prompt.version);
      system = resolved.system;
      promptVersion = resolved.version;
    }
    const messages: ChatMessage[] =
      typeof request.messages === 'string'
        ? [{ role: 'user', content: request.messages }]
        : request.messages;
    return { tier, model, system, promptVersion, messages };
  }

  function toUsageRecord(
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

  async function emit(record: UsageRecord): Promise<void> {
    if (config.onUsage) await config.onUsage(record);
  }

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
      const usage = toUsageRecord(model, tier, promptVersion, result.usage, now() - start);
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
      const usage = toUsageRecord(model, tier, promptVersion, result.usage, now() - start);
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
