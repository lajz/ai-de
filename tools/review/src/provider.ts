import { execFile } from 'node:child_process';

import type { Config } from './types.js';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

/** Build the OpenAI-compatible chat-completions URL from a base that may or may not include /v1. */
export function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return /\/v\d+$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/**
 * Pull a JSON object out of a model response that may wrap it in prose or a
 * ```json fence. Returns the parsed value or throws.
 */
export function extractJson<T = unknown>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('no JSON object found in model response');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Retry-once semantics: 4xx other than 429 are permanent; everything else is transient. */
class PermanentError extends Error {}

/**
 * Build the request body. DeepSeek's flash/pro models reason by default and spend
 * 150s+ / ~20k tokens on a review-sized prompt; `thinking: disabled` cuts that to
 * ~20s with no quality loss for this task. Unknown to other providers but they
 * ignore unknown fields.
 */
export function requestBody(messages: ChatMessage[], cfg: Config): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    messages,
    temperature: 0,
    max_tokens: 16000,
    response_format: { type: 'json_object' },
  };
  if (/deepseek/i.test(cfg.model)) body.thinking = { type: 'disabled' };
  return body;
}

async function attempt(messages: ChatMessage[], cfg: Config): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(chatUrl(cfg.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}),
      },
      body: JSON.stringify(requestBody(messages, cfg)),
    });
    if (!res.ok) {
      const msg = `${cfg.model} @ ${cfg.baseUrl} -> HTTP ${res.status} ${res.statusText}`;
      throw res.status !== 429 && res.status >= 400 && res.status < 500
        ? new PermanentError(msg)
        : new Error(msg);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string }; finish_reason?: string }[];
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content;
    if (!content) throw new Error('empty completion from model');
    if (choice?.finish_reason === 'length') {
      // Truncation is intermittent on DeepSeek under load — retryable, not permanent.
      throw new Error('model response hit the token limit before finishing');
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

async function callOpenAiCompatible(messages: ChatMessage[], cfg: Config): Promise<string> {
  let lastErr: unknown;
  for (let i = 0; i <= cfg.retries; i++) {
    if (i > 0) await sleep(1000 * i);
    try {
      return await attempt(messages, cfg);
    } catch (err) {
      lastErr = err;
      if (err instanceof PermanentError) break;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function callClaudeCli(messages: ChatMessage[], cfg: Config): Promise<string> {
  const prompt = messages.map((m) => m.content).join('\n\n');
  return new Promise((resolve, reject) => {
    const child = execFile(
      'claude',
      ['-p', '--output-format', 'text'],
      { timeout: cfg.timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
    child.stdin?.end(prompt);
  });
}

export function complete(messages: ChatMessage[], cfg: Config): Promise<string> {
  return cfg.model === 'claude'
    ? callClaudeCli(messages, cfg)
    : callOpenAiCompatible(messages, cfg);
}
