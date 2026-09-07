import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { extractionJsonSchema, extractionResultSchema, wrapTranscript } from './prompts/index.js';
import { createProviderFromEnv, loadLlmEnv } from './providers/from-env.js';
import { createRouter } from './router.js';
import type { UsageRecord } from './types.js';

// Pull the worktree `.env` in before the skip check reads the key.
loadLlmEnv();

/**
 * Live smoke against whichever provider the environment points at:
 *   LLM_PROVIDER=anthropic         + ANTHROPIC_API_KEY
 *   LLM_PROVIDER=openai-compatible + LLM_BASE_URL / LLM_API_KEY / LLM_MODEL  (DeepSeek, Ollama)
 * Skipped unless LLM_API_KEY is set.
 */
describe.skipIf(!process.env.LLM_API_KEY)('@fde/llm live smoke', () => {
  it('completes a trivial prompt and reports usage', async () => {
    const records: UsageRecord[] = [];
    const router = createRouter({
      provider: createProviderFromEnv(),
      onUsage: (r) => records.push(r),
    });
    const { text, usage } = await router.complete({
      tier: 'bulk',
      messages: 'Reply with exactly the word: pong',
      maxTokens: 64,
    });
    expect(text.toLowerCase()).toContain('pong');
    expect(usage.outputTokens).toBeGreaterThan(0);
    expect(records).toHaveLength(1);
  }, 60_000);

  it('extracts a fact from a tiny transcript against the real schema', async () => {
    const router = createRouter({ provider: createProviderFromEnv() });
    const transcript = wrapTranscript(
      'Alice: I think we should go with Postgres for the main datastore.\n' +
        "Bob: Agreed, let's lock that in.",
    );
    const { value } = await router.extract(extractionResultSchema, {
      tier: 'bulk',
      prompt: { name: 'extraction' },
      messages: transcript,
      jsonSchema: extractionJsonSchema,
      schemaName: 'record_extraction',
      maxTokens: 2000,
    });
    expect(value.facts.length).toBeGreaterThan(0);
    expect(value.facts.some((f) => f.type === 'decision')).toBe(true);
    z.array(z.string()).parse(value.facts.map((f) => f.summary));
  }, 90_000);
});
