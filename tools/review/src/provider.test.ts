import { describe, expect, it } from 'vitest';

import { chatUrl, extractJson } from './provider.js';

describe('chatUrl', () => {
  it('appends /v1/chat/completions to a bare host', () => {
    expect(chatUrl('https://api.deepseek.com')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });

  it('does not double up when the base already ends in /v1', () => {
    expect(chatUrl('http://localhost:11434/v1')).toBe('http://localhost:11434/v1/chat/completions');
  });

  it('tolerates a trailing slash', () => {
    expect(chatUrl('https://api.deepseek.com/')).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    );
  });
});

describe('extractJson', () => {
  it('parses a bare object', () => {
    expect(extractJson('{"findings":[]}')).toEqual({ findings: [] });
  });

  it('parses an object inside a ```json fence with prose around it', () => {
    const text = 'Here is my review:\n```json\n{"findings":[{"severity":"high"}]}\n```\nThanks!';
    expect(extractJson<{ findings: unknown[] }>(text).findings).toHaveLength(1);
  });

  it('parses an object embedded in loose prose', () => {
    expect(extractJson('sure: {"ok": true} done')).toEqual({ ok: true });
  });

  it('throws when there is no object', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});
