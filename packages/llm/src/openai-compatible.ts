import { DataRetentionError, ProviderRequestError, StructuredOutputError } from './errors.js';
import {
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
  type ProviderTurnRequest,
  type ProviderTurnResult,
} from './provider.js';
import type { Tier } from './types.js';

export interface OpenAiCompatibleConfig {
  /** e.g. `https://api.deepseek.com` or `http://localhost:11434` (Ollama). */
  baseUrl: string;
  apiKey?: string;
  /** Model id for the `default` tier (and `bulk`, unless `bulkModel` is set). */
  model: string;
  bulkModel?: string;
  timeoutMs?: number;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Suppress the "no ZDR" console warning (tests). */
  quiet?: boolean;
}

/** A single OpenAI-style function-call request from the model. */
interface ChatCompletionToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** One entry of this provider's own chat-completions message history — its
 * `ProviderHistory` shape for the tool-calling primitive. */
interface ChatCompletionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ChatCompletionToolCall[];
  tool_call_id?: string;
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ChatCompletionToolCall[] };
    finish_reason?: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number };
}

/** Chat-completions URL from a base that may or may not already include `/v1`. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** Pull a JSON object out of a response that may wrap it in prose or a ```json fence. */
export function extractJsonObject(text: string): unknown {
  const candidate = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new StructuredOutputError('no JSON object found in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * Dev/CI provider: any OpenAI-style `/chat/completions` endpoint (DeepSeek,
 * Ollama, …). **No Zero Data Retention guarantee — never for regulated
 * content.** Structured output is `response_format: json_object` plus a schema
 * instruction in the prompt; the router still validates the result with Zod.
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = 'openai-compatible';
  readonly zeroDataRetention = false;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: OpenAiCompatibleConfig) {
    // Fail-closed, symmetric to `AnthropicProvider`'s own construction-time ZDR
    // invariant: this provider can never carry a Zero Data Retention guarantee
    // (see `zeroDataRetention` above), so it must never back a real deployment
    // — including via the agentic tool-calling loop, which (unlike `complete`/
    // `extract`) this provider now also implements. A regulated engagement must
    // never silently end up here no matter which of the router's call paths it
    // takes; refusing to construct at all under `NODE_ENV=production` closes
    // that off for every call path at once, not just this one.
    if (process.env.NODE_ENV === 'production') {
      throw new DataRetentionError(
        'OpenAiCompatibleProvider has no Zero Data Retention guarantee and must never run with ' +
          'NODE_ENV=production — dev/CI only, never regulated engagements',
      );
    }
    this.fetchImpl = config.fetchImpl ?? globalThis.fetch;
    if (!config.quiet) {
      console.warn(
        `⚠️  @fde/llm: OpenAiCompatibleProvider active (${config.model} @ ${config.baseUrl}) — ` +
          'NO Zero Data Retention guarantee. Dev/CI only, never regulated engagements.',
      );
    }
  }

  modelForTier(tier: Tier): string {
    return tier === 'bulk' ? (this.config.bulkModel ?? this.config.model) : this.config.model;
  }

  async complete(request: ProviderCompleteRequest): Promise<ProviderCompleteResult> {
    const data = await this.call(request, undefined);
    return { text: contentOf(data), usage: usageOf(data) };
  }

  async extract(request: ProviderExtractRequest): Promise<ProviderExtractResult> {
    const data = await this.call(request, request.jsonSchema);
    const usage = usageOf(data);
    try {
      return { value: extractJsonObject(contentOf(data)), usage };
    } catch (err) {
      // The call was made and billed — hand the usage to the router so a
      // model that returned unparseable output is still metered.
      if (err instanceof StructuredOutputError && !err.usage) {
        throw new StructuredOutputError(err.message, err.issues, usage);
      }
      throw err;
    }
  }

  private async call(
    request: ProviderCompleteRequest,
    jsonSchema: Record<string, unknown> | undefined,
  ): Promise<ChatCompletionResponse> {
    const messages: ChatCompletionMessage[] = [];
    if (request.system) messages.push({ role: 'system', content: request.system });
    if (jsonSchema) {
      messages.push({
        role: 'system',
        content: `Respond with a single JSON object valid against this JSON Schema, nothing else:\n${JSON.stringify(jsonSchema)}`,
      });
    }
    for (const m of request.messages) messages.push({ role: m.role, content: m.content });

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      temperature: 0,
      max_tokens: request.maxTokens,
    };
    if (jsonSchema) body.response_format = { type: 'json_object' };
    // DeepSeek reasons by default and burns minutes on a large prompt; other
    // providers ignore the unknown field.
    if (request.thinking === 'disabled' || /deepseek/i.test(request.model)) {
      body.thinking = { type: 'disabled' };
    }

    const data = await this.post(body, request.signal);
    if (data.choices?.[0]?.finish_reason === 'length') {
      throw new StructuredOutputError(
        'model response hit the token limit before finishing',
        undefined,
        usageOf(data),
      );
    }
    return data;
  }

  /**
   * The single-turn tool-calling primitive `Router.runAgentLoop` drives: one
   * `/chat/completions` round-trip using this provider's native function-calling
   * wire format (`tools` array of JSON-schema function defs in, `tool_calls` +
   * `role:"tool"` messages out). `history` is this provider's own
   * `ChatCompletionMessage[]`, threaded through opaquely by `Router` — seeded
   * from `request.messages` on the first turn, otherwise taken verbatim from the
   * previous turn's returned `history` with `request.toolResults` appended as
   * `role:"tool"` messages first.
   */
  async completeTurn(request: ProviderTurnRequest): Promise<ProviderTurnResult> {
    const seedHistory: ChatCompletionMessage[] =
      (request.history as ChatCompletionMessage[] | undefined) ??
      initialMessages(request.system, request.messages);

    const historyWithToolResults: ChatCompletionMessage[] = [
      ...seedHistory,
      ...request.toolResults.map((r): ChatCompletionMessage => ({
        role: 'tool',
        tool_call_id: r.id,
        content: mcpContentToText(r.content),
      })),
    ];

    const body: Record<string, unknown> = {
      model: request.model,
      messages: historyWithToolResults,
      temperature: 0,
      max_tokens: request.maxTokens,
      tools: request.tools.map(toOpenAiTool),
    };
    if (/deepseek/i.test(request.model)) body.thinking = { type: 'disabled' };

    const data = await this.post(body, request.signal);
    const message = data.choices?.[0]?.message;
    if (!message)
      throw new StructuredOutputError('empty completion from model', undefined, usageOf(data));

    const toolCalls: ProviderToolCall[] = (message.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments || '{}') as unknown,
    }));

    const history: ChatCompletionMessage[] = [
      ...historyWithToolResults,
      {
        role: 'assistant',
        content: message.content ?? null,
        ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
      },
    ];

    const finishReason = data.choices?.[0]?.finish_reason;
    const stopReason: ProviderStopReason =
      toolCalls.length > 0 ? 'tool_use' : finishReason === 'length' ? 'max_tokens' : 'end_turn';

    return { history, toolCalls, text: message.content ?? '', usage: usageOf(data), stopReason };
  }

  /** Bare `/chat/completions` POST — status check + JSON parse only. Truncation
   * handling differs by caller (`call()` always treats it as failure; `completeTurn`
   * folds it into `stopReason` since a truncated turn can still carry usable tool
   * calls), so it lives in each caller, not here. */
  private async post(
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
  ): Promise<ChatCompletionResponse> {
    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 120_000);
    const combinedSignal = signal ? AbortSignal.any([timeout, signal]) : timeout;

    const res = await this.fetchImpl(chatCompletionsUrl(this.config.baseUrl), {
      method: 'POST',
      signal: combinedSignal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    // Status only — an error body can echo the prompt (transcript) content, which
    // must never reach a log line on this platform.
    if (!res.ok) throw new ProviderRequestError(res.status, res.statusText || 'request failed');
    return (await res.json()) as ChatCompletionResponse;
  }
}

function initialMessages(
  system: string | undefined,
  messages: { role: string; content: string }[],
): ChatCompletionMessage[] {
  const out: ChatCompletionMessage[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of messages)
    out.push({ role: m.role as ChatCompletionMessage['role'], content: m.content });
  return out;
}

function toOpenAiTool(tool: McpTool): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function contentOf(data: ChatCompletionResponse): string {
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new StructuredOutputError('empty completion from model');
  return content;
}

function usageOf(data: ChatCompletionResponse): ProviderTokenUsage {
  const u = data.usage ?? {};
  const cacheRead = u.prompt_cache_hit_tokens ?? 0;
  // DeepSeek's prompt_tokens is inclusive of cache hits; subtract so inputTokens
  // is the count billed at the full rate.
  return {
    inputTokens: Math.max(0, (u.prompt_tokens ?? 0) - cacheRead),
    outputTokens: u.completion_tokens ?? 0,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: 0,
  };
}
