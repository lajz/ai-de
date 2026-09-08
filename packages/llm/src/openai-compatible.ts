import { ProviderRequestError, StructuredOutputError } from './errors.js';
import type {
  LlmProvider,
  ProviderCompleteRequest,
  ProviderCompleteResult,
  ProviderExtractRequest,
  ProviderExtractResult,
  ProviderTokenUsage,
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

interface ChatCompletionResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
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
    const messages: { role: string; content: string }[] = [];
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

    const timeout = AbortSignal.timeout(this.config.timeoutMs ?? 120_000);
    const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;

    const res = await this.fetchImpl(chatCompletionsUrl(this.config.baseUrl), {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    // Status only — an error body can echo the prompt (transcript) content, which
    // must never reach a log line on this platform.
    if (!res.ok) throw new ProviderRequestError(res.status, res.statusText || 'request failed');

    const data = (await res.json()) as ChatCompletionResponse;
    if (data.choices?.[0]?.finish_reason === 'length') {
      throw new StructuredOutputError(
        'model response hit the token limit before finishing',
        undefined,
        usageOf(data),
      );
    }
    return data;
  }
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
