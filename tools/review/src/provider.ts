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

async function callOpenAiCompatible(messages: ChatMessage[], cfg: Config): Promise<string> {
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
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) {
      throw new Error(`${cfg.model} @ ${cfg.baseUrl} -> HTTP ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('empty completion from model');
    return content;
  } finally {
    clearTimeout(timer);
  }
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
