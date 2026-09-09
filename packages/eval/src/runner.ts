import {
  EXTRACTION_PROMPT_NAME,
  extractionJsonSchema,
  extractionResultSchema,
  getPrompt,
  StructuredOutputError,
  wrapTranscript,
  type Router,
} from '@fde/llm';

import type { Fixture } from './fixtures.js';
import type { EvalReport } from './report.js';
import { aggregate, scoreFixture } from './scorer.js';

/**
 * Run every fixture through the real `router.extract(extractionResultSchema, …)`
 * and score precision/recall + key-phrase recall. One report per prompt version.
 */
export async function runEval(opts: {
  router: Router;
  fixtures: Fixture[];
  promptVersion?: string;
}): Promise<EvalReport> {
  const promptVersion = getPrompt(EXTRACTION_PROMPT_NAME, opts.promptVersion).version;
  let model = opts.router.provider.modelForTier('bulk');
  const perFixture = [];

  for (const fixture of opts.fixtures) {
    try {
      const { value, usage } = await opts.router.extract(extractionResultSchema, {
        prompt: { name: EXTRACTION_PROMPT_NAME, version: promptVersion },
        jsonSchema: extractionJsonSchema,
        schemaName: 'extraction_result',
        tier: 'bulk',
        messages: wrapTranscript(fixture.chunk),
      });
      model = usage.model ?? model;
      perFixture.push(scoreFixture(fixture, value));
    } catch (err) {
      // Any extraction failure — off-schema output, a provider/network error —
      // is a zero for that fixture, not a runner crash: one bad fixture must not
      // mask regressions in the rest. `StructuredOutputError` carries no content;
      // for anything else log the name only.
      const detail =
        err instanceof StructuredOutputError
          ? 'schema-fail'
          : err instanceof Error
            ? err.name
            : 'error';
      console.warn(`eval: ${fixture.id} scored 0 — ${detail}`);
      perFixture.push(scoreFixture(fixture, { facts: [] }));
    }
  }

  return { promptVersion, model, perFixture, aggregate: aggregate(perFixture) };
}
