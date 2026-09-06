import { describe, expect, it } from 'vitest';

import { parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('reads --base and --min', () => {
    const { overrides } = parseArgs(['--base', 'origin/main', '--min', 'medium']);
    expect(overrides.baseRef).toBe('origin/main');
    expect(overrides.minSeverity).toBe('medium');
  });

  it('ignores an invalid --min', () => {
    const { overrides } = parseArgs(['--min', 'nonsense']);
    expect(overrides.minSeverity).toBeUndefined();
  });

  it('--review-only and --security-only set the pass toggles', () => {
    expect(parseArgs(['--review-only']).overrides.passes).toEqual({
      review: true,
      security: false,
    });
    expect(parseArgs(['--security-only']).overrides.passes).toEqual({
      review: false,
      security: true,
    });
  });

  it('captures the sink, request-changes, and help flags', () => {
    expect(parseArgs(['--sink', 'github']).sink).toBe('github');
    expect(parseArgs(['--request-changes']).requestChanges).toBe(true);
    expect(parseArgs([]).requestChanges).toBe(false);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  it('reads --fail-on and ignores a bad value', () => {
    expect(parseArgs(['--fail-on', 'high']).overrides.failOn).toBe('high');
    expect(parseArgs(['--fail-on', 'wat']).overrides.failOn).toBeUndefined();
  });
});
