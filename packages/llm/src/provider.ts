import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

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

/** A tool the model may call this turn — the real MCP protocol's own `Tool` shape,
 * exactly as `mcpClient.listTools()` returns it. Each provider translates this into
 * its own wire format inside its own `completeTurn` (Anthropic's `tools` param,
 * OpenAI-compatible's function-calling `tools` array). */
export type McpTool = Tool;

/** Minimal MCP tool-calling seam — satisfied directly by `@modelcontextprotocol/sdk`'s
 * own `Client` (its `callTool` takes optional extra params this never passes). */
export interface McpToolCaller {
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<CallToolResult>;
}

/** A tool call the model requested this turn. `id` is the provider's own
 * call-correlation id (Anthropic's `tool_use.id`, an OpenAI `tool_call.id`) —
 * opaque to `Router`, threaded back in the matching `ProviderToolResult` so each
 * provider can build the `tool_result`/`role:"tool"` message its own wire format
 * needs. */
export interface ProviderToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** One resolved tool call, ready to fold back into the next turn's history.
 * `content` is the MCP tool result's own content blocks, unmodified — the
 * provider decides how to serialize that into its wire format. */
export interface ProviderToolResult {
  id: string;
  name: string;
  isError: boolean;
  content: CallToolResult['content'];
}

export type ProviderStopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'other';

/**
 * Opaque, provider-owned conversation state threaded through a tool-calling loop.
 * `Router` never constructs or inspects this — it only holds whatever
 * `ProviderTurnResult.history` a provider last returned and passes it back
 * verbatim on the next `completeTurn` call. `undefined` on a loop's first turn,
 * when the provider seeds it from `ProviderTurnRequest.messages`.
 */
export type ProviderHistory = unknown;

export interface ProviderTurnRequest {
  model: string;
  system?: string;
  maxTokens: number;
  /** Tool definitions available this turn, straight from the MCP server. */
  tools: McpTool[];
  /** The loop's original messages — constant across every turn of one loop.
   * Providers use it only to seed `history` when `history` is `undefined`
   * (the first turn); ignored once a prior `history` is supplied. */
  messages: ChatMessage[];
  /** `undefined` on the first turn; otherwise exactly the previous turn's
   * returned `history`. */
  history?: ProviderHistory;
  /** Tool results `Router` collected since the previous turn (empty on the
   * first turn) — folded into `history`, in this provider's own wire format,
   * before the request is sent. */
  toolResults: ProviderToolResult[];
  signal?: AbortSignal;
}

export interface ProviderTurnResult {
  /** Updated history — `Router` passes this back verbatim as `history` on the
   * next turn. */
  history: ProviderHistory;
  /** Tool calls the model requested this turn. Empty ⇒ this was the final turn. */
  toolCalls: ProviderToolCall[];
  text: string;
  usage: ProviderTokenUsage;
  stopReason: ProviderStopReason;
}

export type ProviderAgentEvent =
  | { type: 'tool_call'; name: string; input: unknown }
  /** `content` is the tool's raw MCP result content (e.g. `[{type:'text', text: '...'}]') — the caller decides what, if anything, to parse out of it (e.g. citations). */
  | { type: 'tool_result'; name: string; isError: boolean; content: unknown }
  | { type: 'text'; text: string }
  | { type: 'usage'; usage: ProviderTokenUsage };

/** MCP tool-result content blocks are `[{type:'text', text}, ...]` and friends
 * (image/resource/…) — providers that speak a text-only tool-result wire format
 * (Anthropic's `tool_result` content, an OpenAI `role:"tool"` message) join the
 * text blocks and fall back to a JSON dump of anything else. Shared because both
 * `AnthropicProvider` and `OpenAiCompatibleProvider` need the exact same MCP →
 * text projection, not because the loop itself cares about tool wire formats. */
export function mcpContentToText(content: CallToolResult['content']): string {
  return content
    .map((block) =>
      'text' in block && typeof block.text === 'string' ? block.text : JSON.stringify(block),
    )
    .join('\n');
}

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
   * Single-turn tool-calling primitive: one request/response round-trip against
   * the provider's native tool-calling wire format (Anthropic's `tools` +
   * `tool_use`/`tool_result` content blocks; an OpenAI-compatible endpoint's
   * `tools` function-calling array + `tool_calls`/`role:"tool"` messages).
   * Optional: only providers with native tool-calling support implement it.
   * The multi-turn loop itself lives in `Router.runAgentLoop`, generically,
   * over this primitive — not here. `Router` throws a clear error if the
   * active provider omits it.
   */
  completeTurn?(request: ProviderTurnRequest): Promise<ProviderTurnResult>;
}

export const EMPTY_USAGE: ProviderTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
};
