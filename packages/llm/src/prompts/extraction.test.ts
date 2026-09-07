import { describe, expect, it } from 'vitest';

import { PromptNotFoundError } from '../errors.js';
import { EXTRACTION_PROMPT_VERSION, extractionResultSchema, wrapTranscript } from './extraction.js';
import { getPrompt, listPromptVersions, registerPrompt } from './registry.js';

describe('prompt registry', () => {
  it('resolves the extraction prompt and its version', () => {
    const p = getPrompt('extraction');
    expect(p.version).toBe(EXTRACTION_PROMPT_VERSION);
    expect(p.system).toContain('decision');
  });

  it('resolves an explicit version', () => {
    expect(getPrompt('extraction', EXTRACTION_PROMPT_VERSION).version).toBe(
      EXTRACTION_PROMPT_VERSION,
    );
  });

  it('throws PromptNotFoundError for an unknown name or version', () => {
    expect(() => getPrompt('nope')).toThrow(PromptNotFoundError);
    expect(() => getPrompt('extraction', '1999-01-01')).toThrow(PromptNotFoundError);
  });

  it('returns the highest-sorting version when none is given', () => {
    registerPrompt({ name: 'demo', version: '2025-01-01', system: 'old' });
    registerPrompt({ name: 'demo', version: '2026-06-01', system: 'new' });
    expect(getPrompt('demo').system).toBe('new');
    expect(listPromptVersions('demo')).toEqual(['2026-06-01', '2025-01-01']);
  });

  it('rejects a conflicting redefinition of the same version', () => {
    registerPrompt({ name: 'dup', version: 'v1', system: 'a' });
    expect(() => registerPrompt({ name: 'dup', version: 'v1', system: 'b' })).toThrow();
    expect(() => registerPrompt({ name: 'dup', version: 'v1', system: 'a' })).not.toThrow();
  });
});

describe('extraction schema', () => {
  it('parses a well-formed extraction result (as a mocked model would return)', () => {
    const canned = {
      facts: [
        {
          type: 'decision',
          summary: 'The team will use PostgreSQL for the system of record.',
          detail: 'Chosen over DynamoDB for relational querying and pgvector.',
          confidence: 0.9,
          occurredAt: '2026-02-14T15:04:00.000Z',
          evidence: [
            {
              quote: "let's just go with Postgres for the main store",
              charStart: 40,
              charEnd: 84,
              relation: 'supports',
            },
          ],
        },
        {
          type: 'action_item',
          summary: 'Send the draft SOW to the customer by Friday.',
          confidence: 0.75,
          evidence: [{ quote: "I'll get the SOW over to you Friday" }],
        },
      ],
    };
    const parsed = extractionResultSchema.parse(canned);
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[1]!.evidence[0]!.relation).toBe('supports'); // default applied
  });

  it('rejects an out-of-range confidence and an unknown fact type', () => {
    expect(
      extractionResultSchema.safeParse({
        facts: [{ type: 'banana', summary: 'x', confidence: 0.1, evidence: [{ quote: 'q' }] }],
      }).success,
    ).toBe(false);
    expect(
      extractionResultSchema.safeParse({
        facts: [{ type: 'risk', summary: 'x', confidence: 1.5, evidence: [{ quote: 'q' }] }],
      }).success,
    ).toBe(false);
  });

  it('wrapTranscript fences the chunk in data markers', () => {
    expect(wrapTranscript('hi there')).toBe('<transcript>\nhi there\n</transcript>');
  });
});
