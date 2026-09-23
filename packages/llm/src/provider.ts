import type { MCPClientLike, MCPToolLike } from '@anthropic-ai/sdk/helpers/beta/mcp';

import type { ChatMessage, Effort, ThinkingMode, Tier } from './types.js';

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
  /** JSON Schema for the object the model must return. */
  jsonSchema: Record<string, unknown>;
  /** Name for the schema / tool — surfaced to the model. */
  schemaName: string;
}

export interface ProviderExtractResult {
  /** Parsed JSON object, NOT yet validated against the caller's Zod schema. */
  value: unknown;
  usage: ProviderTokenUsage;
}

export interface ProviderAgentLoopRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  maxTokens: number;
  /** Hard cap on tool-call/response round-trips — the step cap. Required, never defaulted by the provider. */
  maxIterations: number;
  /** Tool definitions as returned by `mcpClient.listTools()`. */
  mcpTools: MCPToolLike[];
  mcpClient: MCPClientLike;
  signal?: AbortSignal;
}

export type ProviderAgentEvent =
  | { type: 'tool_call'; name: string; input: unknown }
  /** `content` is the tool's raw MCP result content (e.g. `[{type:'text', text: '...'}]') — the caller decides what, if anything, to parse out of it (e.g. citations). */
  | { type: 'tool_result'; name: string; isError: boolean; content: unknown }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: ProviderTokenUsage };

/**
 * A model backend. `AnthropicProvider` is production (Claude + ZDR);
 * `OpenAiCompatibleProvider` is the dev/CI seam (DeepSeek, Ollama).
 */
export interface LlmProvider {
  readonly name: string;
  /**
   * Whether calls carry a Zero Data Retention guarantee. `false` ⇒ dev/CI only,
   * never regulated content. The router surfaces this and `assertZeroDataRetention()`.
   */
  readonly zeroDataRetention: boolean;
  modelForTier(tier: Tier): string;
  complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResult>;
  extract(request: ProviderExtractRequest): Promise<ProviderExtractResult>;
  /**
   * Multi-step tool-calling loop over an MCP tool set. Optional: only
   * providers with native agentic tool-calling support implement it (today,
   * only `AnthropicProvider` — Tool Runner is Anthropic-SDK-specific). The
   * router throws a clear error if the active provider omits it.
   */
  runAgentLoop?(
    request: ProviderAgentLoopRequest,
  ): AsyncGenerator<ProviderAgentEvent, void, undefined>;
}

export const EMPTY_USAGE: ProviderTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
