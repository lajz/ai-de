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

  it('captures the sink and help flag', () => {
    expect(parseArgs(['--sink', 'github']).sink).toBe('github');
    expect(parseArgs(['--help']).help).toBe(true);
  });
});
