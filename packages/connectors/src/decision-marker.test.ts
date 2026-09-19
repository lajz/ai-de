import { describe, expect, it } from 'vitest';

import { extractDecisionRefs } from './decision-marker.js';

describe('extractDecisionRefs', () => {
  it('extracts distinct decision ids in first-seen order, ignoring duplicates', () => {
    expect(
      extractDecisionRefs('see fde:decision:dec-1 and fde:decision:dec-2 and fde:decision:dec-1'),
    ).toEqual(['dec-1', 'dec-2']);
  });

  it('returns an empty array for null, empty, or marker-free text', () => {
    expect(extractDecisionRefs(null)).toEqual([]);
    expect(extractDecisionRefs(undefined)).toEqual([]);
    expect(extractDecisionRefs('')).toEqual([]);
    expect(extractDecisionRefs('no markers here')).toEqual([]);
  });
});
