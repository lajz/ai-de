import { describe, expect, it } from 'vitest';

import {
  type UsageRecord,
  createProviderFromEnv,
  createRouter,
  extractionJsonSchema,
  extractionResultSchema,
  loadLlmEnv,
  wrapTranscript,
} from './index.js';

// Pull the worktree `.env` in before the skip check reads the key.
loadLlmEnv();

/**
 * Live smoke against whichever provider the environment points at:
 *   LLM_PROVIDER=anthropic         + ANTHROPIC_API_KEY
 *   LLM_PROVIDER=openai-compatible + LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
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

  it('extracts a decision from a tiny transcript against the real schema', async () => {
    const router = createRouter({ provider: createProviderFromEnv() });
    const { value } = await router.extract(extractionResultSchema, {
      tier: 'bulk',
      prompt: { name: 'extraction' },
      messages: wrapTranscript(
        'Alice: I think we should go with Postgres for the main datastore.\nBob: Agreed, locking that in.',
      ),
      jsonSchema: extractionJsonSchema,
      schemaName: 'record_extraction',
      maxTokens: 2000,
    });
    expect(value.facts.some((f) => f.type === 'decision')).toBe(true);
  }, 90_000);
});
