import type { z } from 'zod';

import { createProviderFromEnv } from './env.js';
import { AgentLoopUnsupportedError, DataRetentionError, StructuredOutputError } from './errors.js';
import { computeChatCostUsd } from './pricing.js';
import type {
  LlmProvider,
  McpTool,
  McpToolCaller,
  ProviderHistory,
  ProviderTokenUsage,
  ProviderToolResult,
} from './provider.js';
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

export interface AgentLoopRequest {
  tier?: Tier;
  model?: string;
  prompt?: PromptRef;
  system?: string;
  messages: string | ChatMessage[];
  maxTokens?: number;
  /** Hard cap on tool-call/response round-trips — always required, never defaulted, so a caller can't forget the step cap. */
  maxIterations: number;
  mcpTools: McpTool[];
  mcpClient: McpToolCaller;
  signal?: AbortSignal;
}

export type AgentLoopEvent =
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; isError: boolean; content: unknown }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: UsageRecord };

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
  /**
   * Multi-step tool-calling loop over an MCP tool set — implemented once,
   * generically, here: repeatedly call the active provider's single-turn
   * `completeTurn` primitive, execute any requested tool calls against
   * `mcpClient`, feed results back for the next turn, stop on a turn with no
   * tool calls or the `maxIterations` cap. Throws `AgentLoopUnsupportedError`
   * if the active provider doesn't implement `completeTurn`. Emits one
   * `{type:'usage'}` event — and one `onUsage` sink call — per LLM turn,
   * exactly like `complete`/`extract` meter their single call.
   */
  runAgentLoop(request: AgentLoopRequest): AsyncGenerator<AgentLoopEvent, void, undefined>;
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
      let result;
      try {
        result = await provider.extract({
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
      } catch (err) {
        // A structured-output failure the provider still paid for (no tool call,
        // truncated response): meter it before propagating, so onUsage never
        // misses a billed call.
        if (err instanceof StructuredOutputError && err.usage) {
          await emit(record(model, tier, promptVersion, err.usage, now() - start));
        }
        throw err;
      }
      // Emit before validating: the call was made and billed regardless of
      // whether the model's output parses, and the sink must see that cost.
      const usage = record(model, tier, promptVersion, result.usage, now() - start);
      await emit(usage);

      const parsed = schema.safeParse(result.value);
      if (!parsed.success) {
        // `usage` was already emitted above; carry it on the error too so a
        // caller catching this still knows the call landed and was billed.
        throw new StructuredOutputError(
          'model output failed schema validation',
          parsed.error.issues,
          result.usage,
        );
      }
      return { value: parsed.data, usage };
    },

    async *runAgentLoop(request) {
      if (!provider.completeTurn) throw new AgentLoopUnsupportedError(provider.name);
      // Bound, not a bare `provider.completeTurn` reference: both providers'
      // `completeTurn` reads `this` (`this.post`/`this.client`), and calling
      // an unbound method loses that receiver — throwing on the very first
      // turn every time, silently swallowed by `AgenticQaService`'s
      // guaranteed-answer fallback to the one-shot path.
      const completeTurn = provider.completeTurn.bind(provider);
      const { tier, model, system, promptVersion, messages } = resolve(request);
      const maxTokens = request.maxTokens ?? defaultMaxTokens;

      let history: ProviderHistory | undefined;
      let toolResults: ProviderToolResult[] = [];

      for (let iteration = 0; iteration < request.maxIterations; iteration++) {
        const turnStart = now();
        const result = await completeTurn({
          model,
          system,
          maxTokens,
          tools: request.mcpTools,
          messages,
          history,
          toolResults,
          signal: request.signal,
        });
        history = result.history;

        if (result.text) yield { type: 'text', text: result.text };

        const nextToolResults: ProviderToolResult[] = [];
        for (const call of result.toolCalls) {
          yield { type: 'tool_call', name: call.name, input: call.input };
          const mcpResult = await request.mcpClient.callTool({
            name: call.name,
            arguments: call.input as Record<string, unknown> | undefined,
          });
          const isError = mcpResult.isError ?? false;
          yield { type: 'tool_result', name: call.name, isError, content: mcpResult.content };
          nextToolResults.push({
            id: call.id,
            name: call.name,
            isError,
            content: mcpResult.content,
          });
        }

        const usage = record(model, tier, promptVersion, result.usage, now() - turnStart);
        await emit(usage);
        yield { type: 'usage', usage };

        if (result.toolCalls.length === 0) return; // final turn — no more tool calls requested
        toolResults = nextToolResults;
      }
    },
  };
}
