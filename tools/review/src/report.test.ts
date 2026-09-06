import { describe, expect, it } from 'vitest';

import { filterBySeverity, render, sortFindings } from './report.js';
import type { Finding, ReviewContext } from './types.js';

const f = (over: Partial<Finding>): Finding => ({
  severity: 'low',
  file: 'x.ts',
  line: null,
  title: 't',
  detail: 'd',
  suggestion: '',
  pass: 'review',
  ...over,
});

const ctx: ReviewContext = {
  base: 'origin/main',
  head: 'abc1234',
  changedFiles: ['x.ts'],
  truncatedFiles: [],
};

describe('sortFindings', () => {
  it('orders high -> nit, then by file', () => {
    const out = sortFindings([
      f({ severity: 'nit' }),
      f({ severity: 'high', file: 'b.ts' }),
      f({ severity: 'high', file: 'a.ts' }),
    ]);
    expect(out.map((x) => [x.severity, x.file])).toEqual([
      ['high', 'a.ts'],
      ['high', 'b.ts'],
      ['nit', 'x.ts'],
    ]);
  });
});

describe('filterBySeverity', () => {
  it('keeps only findings at or above the threshold', () => {
    const list = [f({ severity: 'high' }), f({ severity: 'low' }), f({ severity: 'nit' })];
    expect(filterBySeverity(list, 'low').map((x) => x.severity)).toEqual(['high', 'low']);
  });
});

describe('render', () => {
  it('states the advisory nature and lists a finding', () => {
    const out = render([f({ severity: 'high', title: 'RLS bypass', line: 9 })], ctx, 'nit');
    expect(out).toContain('RLS bypass');
    expect(out).toContain('x.ts:9');
    expect(out).toContain('advisory only, push not blocked');
  });

  it('says so when nothing meets the threshold', () => {
    const out = render([f({ severity: 'nit' })], ctx, 'high');
    expect(out).toContain('no findings at or above severity high');
  });
});
