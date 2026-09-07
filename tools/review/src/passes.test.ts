import { afterEach, describe, expect, it, vi } from 'vitest';

import { dedupeFindings, normalize, runPass } from './passes.js';
import type { Config, Finding, PriorFinding } from './types.js';

const mk = (o: Partial<Finding>): Finding => ({
  severity: 'low',
  file: 'a.ts',
  line: 10,
  title: 't',
  detail: 'd',
  suggestion: '',
  pass: 'review',
  ...o,
});

describe('normalize', () => {
  it('coerces a well-formed finding and tags the pass', () => {
    const out = normalize(
      [{ severity: 'high', file: 'a.ts', line: 12, title: 'X', detail: 'bad', suggestion: 'fix' }],
      'security',
    );
    expect(out).toEqual([
      {
        severity: 'high',
        file: 'a.ts',
        line: 12,
        title: 'X',
        detail: 'bad',
        suggestion: 'fix',
        pass: 'security',
      },
    ]);
  });

  it('defaults an unknown severity to low and a missing line to null', () => {
    const [f] = normalize([{ severity: 'catastrophic', file: 'a.ts', detail: 'x' }], 'review');
    expect(f!.severity).toBe('low');
    expect(f!.line).toBeNull();
  });

  it('drops entries with no detail and non-object junk', () => {
    const out = normalize(
      [null as never, 'nope' as never, { severity: 'low', file: 'a.ts', title: 't' }],
      'review',
    );
    expect(out).toEqual([]);
  });

  it('rejects a zero or negative line number', () => {
    const [f] = normalize([{ file: 'a.ts', detail: 'x', line: 0 }], 'review');
    expect(f!.line).toBeNull();
  });
});

describe('dedupeFindings', () => {
  it('merges two findings on the same file+line, keeping the more severe', () => {
    const out = dedupeFindings([
      mk({ line: 585, severity: 'low', title: 'Avoid passing null line to the API' }),
      mk({ line: 585, severity: 'medium', title: 'Guard against null line' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('medium');
  });

  it('merges the same title reported by both passes (different line)', () => {
    const out = dedupeFindings([
      mk({ pass: 'review', line: 10, title: 'Missing tenant scope' }),
      mk({ pass: 'security', line: 40, title: 'missing tenant scope' }),
    ]);
    expect(out).toHaveLength(1);
  });

  it('keeps distinct findings on adjacent lines', () => {
    const out = dedupeFindings([
      mk({ line: 10, title: 'null check missing' }),
      mk({ line: 12, title: 'wrong variable used' }),
    ]);
    expect(out).toHaveLength(2);
  });

  it('collapses two line-less findings with the same title', () => {
    const out = dedupeFindings([
      mk({ line: null, title: 'workflow leaks secrets' }),
      mk({ line: null, title: 'Workflow leaks secrets!' }),
    ]);
    expect(out).toHaveLength(1);
  });
});

describe('runPass — retractions', () => {
  afterEach(() => vi.unstubAllGlobals());

  const cfg = {
    model: 'deepseek-v4-flash',
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'sk-x',
    timeoutMs: 1000,
    retries: 0,
  } as Config;

  const respond = (obj: unknown) =>
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(obj) }, finish_reason: 'stop' }],
      }),
    } as Response);

  it('maps a retraction number back to the prior finding key', async () => {
    const prior: PriorFinding[] = [
      { key: 'aaaaaaaaaa', pass: 'review', file: 'a.ts', line: 5, title: 'X', detail: 'd' },
      { key: 'bbbbbbbbbb', pass: 'review', file: 'b.ts', line: 9, title: 'Y', detail: 'd' },
    ];
    vi.stubGlobal(
      'fetch',
      respond({ findings: [], retractions: [{ n: 2, reason: 'guarded at the caller' }] }),
    );
    const res = await runPass('review', 'diff', cfg, prior);
    expect(res.retractions).toEqual([{ key: 'bbbbbbbbbb', reason: 'guarded at the caller' }]);
  });

  it('ignores a retraction with a bad number or empty reason', async () => {
    const prior: PriorFinding[] = [
      { key: 'aaaaaaaaaa', pass: 'review', file: 'a.ts', line: 5, title: 'X', detail: 'd' },
    ];
    vi.stubGlobal(
      'fetch',
      respond({
        findings: [],
        retractions: [
          { n: 9, reason: 'x' },
          { n: 1, reason: '' },
        ],
      }),
    );
    expect((await runPass('review', 'd', cfg, prior)).retractions).toEqual([]);
  });

  it('returns no retractions when none were given', async () => {
    vi.stubGlobal('fetch', respond({ findings: [] }));
    expect((await runPass('review', 'd', cfg)).retractions).toEqual([]);
  });
});
