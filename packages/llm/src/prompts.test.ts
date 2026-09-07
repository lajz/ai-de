import { describe, expect, it } from 'vitest';

import {
  EXTRACTION_PROMPT_VERSION,
  PromptNotFoundError,
  extractionResultSchema,
  getPrompt,
  listPromptVersions,
  registerPrompt,
  wrapTranscript,
} from './index.js';

describe('prompt registry', () => {
  it('resolves the extraction prompt (latest and by explicit version)', () => {
    expect(getPrompt('extraction').version).toBe(EXTRACTION_PROMPT_VERSION);
    expect(getPrompt('extraction').system).toContain('decision');
    expect(getPrompt('extraction', EXTRACTION_PROMPT_VERSION).version).toBe(
      EXTRACTION_PROMPT_VERSION,
    );
  });

  it('throws PromptNotFoundError for an unknown name or version', () => {
    expect(() => getPrompt('nope')).toThrow(PromptNotFoundError);
    expect(() => getPrompt('extraction', '1999-01-01')).toThrow(PromptNotFoundError);
  });

  it('returns the highest-sorting version and rejects a conflicting redefinition', () => {
    registerPrompt({ name: 'demo', version: '2025-01-01', system: 'old' });
    registerPrompt({ name: 'demo', version: '2026-06-01', system: 'new' });
    expect(getPrompt('demo').system).toBe('new');
    expect(listPromptVersions('demo')).toEqual(['2026-06-01', '2025-01-01']);
    expect(() => registerPrompt({ name: 'demo', version: 'v1', system: 'a' })).not.toThrow();
    expect(() => registerPrompt({ name: 'demo', version: 'v1', system: 'b' })).toThrow();
  });
});

describe('extraction schema', () => {
  it('parses a well-formed result (as a mocked model would return) and applies the relation default', () => {
    const parsed = extractionResultSchema.parse({
      facts: [
        {
          type: 'decision',
          summary: 'The team will use PostgreSQL for the system of record.',
          detail: 'Chosen over DynamoDB for relational querying and pgvector.',
          confidence: 0.9,
          occurredAt: '2026-02-14T15:04:00.000Z',
          evidence: [{ quote: "let's just go with Postgres", charStart: 40, charEnd: 66 }],
        },
        {
          type: 'action_item',
          summary: 'Send the draft SOW to the customer by Friday.',
          confidence: 0.75,
          evidence: [{ quote: "I'll get the SOW over Friday" }],
        },
      ],
    });
    expect(parsed.facts).toHaveLength(2);
    expect(parsed.facts[1]!.evidence[0]!.relation).toBe('supports');
  });

  it('rejects an unknown fact type and an out-of-range confidence', () => {
    const bad = (type: string, confidence: number) =>
      extractionResultSchema.safeParse({
        facts: [{ type, summary: 'x', confidence, evidence: [{ quote: 'q' }] }],
      }).success;
    expect(bad('banana', 0.1)).toBe(false);
    expect(bad('risk', 1.5)).toBe(false);
  });

  it('wrapTranscript fences the chunk in data markers', () => {
    expect(wrapTranscript('hi there')).toBe('<transcript>\nhi there\n</transcript>');
  });
});
