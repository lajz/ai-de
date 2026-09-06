import { describe, expect, it } from 'vitest';

import { normalize } from './passes.js';

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
