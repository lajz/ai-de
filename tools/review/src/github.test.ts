import { describe, expect, it } from 'vitest';

import {
  commentBody,
  computeVerdict,
  findingKey,
  keyFromBody,
  markerFor,
  parsePrevState,
  planActions,
  renderSummary,
  type ThreadInfo,
} from './github.js';
import type { Finding } from './types.js';

const f = (over: Partial<Finding>): Finding => ({
  severity: 'medium',
  file: 'src/x.ts',
  line: 10,
  title: 'Something is off',
  detail: 'because reasons',
  suggestion: '',
  pass: 'review',
  ...over,
});

describe('findingKey', () => {
  it('is stable across line moves and detail edits', () => {
    expect(findingKey(f({ line: 10, detail: 'a' }))).toBe(findingKey(f({ line: 99, detail: 'b' })));
  });

  it('differs by file, pass, and title', () => {
    const base = findingKey(f({}));
    expect(findingKey(f({ file: 'src/y.ts' }))).not.toBe(base);
    expect(findingKey(f({ pass: 'security' }))).not.toBe(base);
    expect(findingKey(f({ title: 'A totally different problem' }))).not.toBe(base);
  });

  it('is 10 hex chars', () => {
    expect(findingKey(f({}))).toMatch(/^[a-f0-9]{10}$/);
  });
});

describe('marker round-trip', () => {
  it('keyFromBody recovers the key markerFor embeds', () => {
    const key = findingKey(f({}));
    expect(keyFromBody(`text\n\n${markerFor(key)}\n`)).toBe(key);
  });

  it('returns null when absent', () => {
    expect(keyFromBody('a plain human comment')).toBeNull();
  });
});

describe('commentBody', () => {
  it('includes severity, pass, title, detail, the marker, and (when present) the fix', () => {
    const body = commentBody(
      f({ severity: 'high', pass: 'security', suggestion: 'do X' }),
      'abcabc1234',
    );
    expect(body).toContain('HIGH · security');
    expect(body).toContain('Something is off');
    expect(body).toContain('because reasons');
    expect(body).toContain('_Suggested fix:_ do X');
    expect(body).toContain('<!-- fde-review:key=abcabc1234 -->');
  });

  it('omits the fix line when there is no suggestion', () => {
    expect(commentBody(f({ suggestion: '' }), 'k000000000')).not.toContain('Suggested fix');
  });
});

describe('planActions', () => {
  const open = (key: string): ThreadInfo => ({
    key,
    threadId: `T_${key}`,
    isResolved: false,
    rootCommentId: 1,
  });
  const resolved = (key: string): ThreadInfo => ({ ...open(key), isResolved: true });

  it('creates a comment for a finding with no thread', () => {
    const finding = f({});
    const plan = planActions([finding], []);
    expect(plan.toCreate).toEqual([finding]);
    expect(plan.toResolve).toEqual([]);
  });

  it('leaves an open thread that still matches a finding alone', () => {
    const finding = f({});
    const plan = planActions([finding], [open(findingKey(finding))]);
    expect(plan.toCreate).toEqual([]);
    expect(plan.stillOpen).toHaveLength(1);
    expect(plan.toResolve).toEqual([]);
  });

  it('resolves an open thread whose finding is gone', () => {
    const stale = open('deadbeef01');
    const plan = planActions([], [stale]);
    expect(plan.toResolve).toEqual([stale]);
  });

  it('reopens a resolved thread whose finding came back', () => {
    const finding = f({});
    const thread = resolved(findingKey(finding));
    const plan = planActions([finding], [thread]);
    expect(plan.toReopen).toEqual([thread]);
    expect(plan.toCreate).toEqual([]);
  });

  it('ignores an already-resolved thread whose finding is still gone', () => {
    const plan = planActions([], [resolved('cafecafe01')]);
    expect(plan.toResolve).toEqual([]);
    expect(plan.toReopen).toEqual([]);
  });
});

describe('computeVerdict', () => {
  it('approves when nothing meets the blocking severity', () => {
    const v = computeVerdict([f({ severity: 'medium' }), f({ severity: 'low' })], 'high');
    expect(v.approve).toBe(true);
    expect(v.blocking).toEqual([]);
  });

  it('withholds approval and lists blockers at or above the threshold', () => {
    const v = computeVerdict([f({ severity: 'high' }), f({ severity: 'medium' })], 'high');
    expect(v.approve).toBe(false);
    expect(v.blocking).toHaveLength(1);
  });

  it('honors a lower blocking threshold', () => {
    expect(computeVerdict([f({ severity: 'medium' })], 'medium').approve).toBe(false);
  });
});

describe('parsePrevState', () => {
  it('reads run and verdict from a prior summary', () => {
    expect(parsePrevState('...\n<!-- fde-review:state run=4 verdict=approve -->')).toEqual({
      run: 4,
      verdict: 'approve',
    });
  });

  it('defaults to run 0 / null when missing', () => {
    expect(parsePrevState(null)).toEqual({ run: 0, verdict: null });
    expect(parsePrevState('nothing here')).toEqual({ run: 0, verdict: null });
  });
});

describe('renderSummary', () => {
  const baseInput = {
    model: 'deepseek-v4-flash',
    base: 'abcdef1234567',
    headSha: '1234567abcdef',
    run: 2,
    resolvedThisRun: 1,
    blockingSeverity: 'high' as const,
    unpositioned: [],
  };

  it('shows the approve verdict, the run number, and a marker', () => {
    const findings = [f({ severity: 'low' })];
    const out = renderSummary({
      ...baseInput,
      findings,
      plan: planActions(findings, []),
      verdict: computeVerdict(findings, 'high'),
    });
    expect(out).toContain('run 2');
    expect(out).toContain('✅ no blocking findings');
    expect(out).toContain('<!-- fde-review:state run=2 verdict=approve -->');
    expect(out).toContain('<!-- fde-review:summary -->');
    expect(out).toContain('🆕');
  });

  it('shows the blocked verdict when a high finding is present', () => {
    const findings = [f({ severity: 'high' })];
    const out = renderSummary({
      ...baseInput,
      findings,
      plan: planActions(findings, []),
      verdict: computeVerdict(findings, 'high'),
    });
    expect(out).toContain('approval withheld');
    expect(out).toContain('verdict=block');
  });
});
