import Anthropic from '@anthropic-ai/sdk';

import { DataRetentionError, StructuredOutputError } from './errors.js';
import {
  EMPTY_USAGE,
  mcpContentToText,
  type LlmProvider,
  type McpTool,
  type ProviderCompleteRequest,
  type ProviderCompleteResult,
  type ProviderExtractRequest,
  type ProviderExtractResult,
  type ProviderStopReason,
  type ProviderTokenUsage,
  type ProviderToolCall,
  type ProviderToolResult,
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from './provider.js';
import type { Tier } from './types.js';

/** Above this `maxTokens` the provider streams and coalesces (`.finalMessage()`) to dodge HTTP timeouts. */
const STREAM_THRESHOLD_TOKENS = 16_000;

export interface AnthropicProviderConfig {
  apiKey?: string;
  /**
   * Non-Anthropic endpoint (Bedrock, a ZDR proxy). Setting this is what makes
   * `zeroDataRetention: false` permissible — see `DataRetentionError`.
   */
  baseURL?: string;
  /** Default `true`. `false` is only allowed together with a `baseURL`. */
  zeroDataRetention?: boolean;
  maxRetries?: number;
  /** Tier → model id. Defaults to opus-5 (`default`) / sonnet-5 (`bulk`) per `docs/architecture.md`. */
  models?: Record<Tier, string>;
  /** Test seam — inject a pre-built SDK client (or a stub). */
  client?: Pick<Anthropic, 'messages'>;
}

const DEFAULT_MODELS: Record<Tier, string> = {
  default: 'claude-opus-5',
  bulk: 'claude-sonnet-5',
};

/** Anthropic's own multi-turn message history shape — this provider's `ProviderHistory`. */
type AnthropicHistory = Anthropic.MessageParam[];

/**
 * Production provider: Claude via `@anthropic-ai/sdk`. Zero Data Retention is a
 * construction-time invariant (the backing Anthropic org must be ZDR-enabled);
 * pointing `baseURL` elsewhere is the documented way to run against Bedrock or a
 * proxy later — a config change, not a code change.
 */
export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly zeroDataRetention: boolean;
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly models: Record<Tier, string>;

  constructor(config: AnthropicProviderConfig = {}) {
    const zdr = config.zeroDataRetention ?? true;
    const firstParty = !config.baseURL;
    if (firstParty && !zdr) throw new DataRetentionError();
    this.zeroDataRetention = zdr;
    this.models = config.models ?? DEFAULT_MODELS;
    this.client =
      config.client ??
      new Anthropic({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        maxRetries: config.maxRetries ?? 2,
        // Never let the SDK log request/response bodies, at any level.
        logLevel: 'off',
      });
  }

  modelForTier(tier: Tier): string {
    return this.models[tier];
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResult> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      thinking: request.thinking === 'disabled' ? { type: 'disabled' } : { type: 'adaptive' },
      ...(request.system ? { system: request.system } : {}),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    };

    const shouldStream = request.stream === true || request.maxTokens > STREAM_THRESHOLD_TOKENS;
    const message = shouldStream
      ? await this.client.messages.stream(params, { signal: request.signal }).finalMessage()
      : await this.client.messages.create(params, { signal: request.signal });

    return { text: textOf(message), usage: usageOf(message) };
  }

  async extract(request: ProviderExtractRequest): Promise<ProviderExtractResult> {
    // Tool-use for structured output — `tool_choice: auto` (not forced) so it stays
    // compatible with adaptive thinking; a single tool + no parallel calls makes
    // the one call unambiguous. The system prompt instructs the model to call it.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      thinking: request.thinking === 'disabled' ? { type: 'disabled' } : { type: 'adaptive' },
      tools: [
        {
          name: request.schemaName,
          description: 'Record the structured result. Call this exactly once.',
          input_schema: request.jsonSchema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      ...(request.system ? { system: request.system } : {}),
      ...(request.effort ? { output_config: { effort: request.effort } } : {}),
    };

    // Same timeout guard as `complete`: a large `max_tokens` extraction streams
    // and coalesces so a slow generation can't trip the HTTP idle timeout.
    const message =
      request.maxTokens > STREAM_THRESHOLD_TOKENS
        ? await this.client.messages.stream(params, { signal: request.signal }).finalMessage()
        : await this.client.messages.create(params, { signal: request.signal });
    const call = message.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === request.schemaName,
    );
    if (!call) {
      throw new StructuredOutputError(
        `model did not call the "${request.schemaName}" tool`,
        undefined,
        usageOf(message),
      );
    }
    return { value: call.input, usage: usageOf(message) };
  }

  /**
   * The single-turn tool-calling primitive `Router.runAgentLoop` drives: one
   * `messages.create` round-trip against the Messages API's native `tools` /
   * `tool_use` / `tool_result` content blocks. `history` is this provider's own
   * `Anthropic.MessageParam[]`, threaded through opaquely by `Router` — seeded
   * from `request.messages` on the first turn, otherwise taken verbatim from
   * the previous turn's returned `history` with `request.toolResults` folded
   * in as a `tool_result` user turn first.
   */
  async completeTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const seedHistory: AnthropicHistory =
      (request.history as AnthropicHistory | undefined) ??
      request.messages.map((m) => ({ role: m.role, content: m.content }));

    const historyWithToolResults: AnthropicHistory =
      request.toolResults.length > 0
        ? [
            ...seedHistory,
            { role: 'user', content: request.toolResults.map(toAnthropicToolResult) },
          ]
        : seedHistory;

    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxTokens,
      messages: historyWithToolResults,
      tools: request.tools.map(toAnthropicTool),
      ...(request.system ? { system: request.system } : {}),
    };

    const shouldStream = request.maxTokens > STREAM_THRESHOLD_TOKENS;
    const message = shouldStream
      ? await this.client.messages.stream(params, { signal: request.signal }).finalMessage()
      : await this.client.messages.create(params, { signal: request.signal });

    const toolCalls: ProviderToolCall[] = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map((b) => ({ id: b.id, name: b.name, input: b.input }));

    const history: AnthropicHistory = [
      ...historyWithToolResults,
      { role: 'assistant', content: message.content },
    ];

    return {
      history,
      toolCalls,
      text: textOf(message),
      usage: usageOf(message),
      stopReason: mapStopReason(message.stop_reason),
    };
  }
}

function toAnthropicTool(tool: McpTool): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicToolResult(result: ProviderToolResult): Anthropic.ToolResultBlockParam {
  return {
    type: 'tool_result',
    tool_use_id: result.id,
    content: mcpContentToText(result.content),
    is_error: result.isError,
  };
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): ProviderStopReason {
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'max_tokens') return 'max_tokens';
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end_turn';
  return 'other';
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function usageOf(message: Anthropic.Message): ProviderTokenUsage {
  const u = message.usage;
  if (!u) return EMPTY_USAGE;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
  };
}
