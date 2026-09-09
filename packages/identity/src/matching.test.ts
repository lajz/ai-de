import { describe, expect, it } from 'vitest';

import {
  AUTO_MERGE_THRESHOLD,
  deterministicKeys,
  domainsOf,
  IDENTITY_REF_DOMAIN,
  IDENTITY_REF_EMAIL,
  IDENTITY_REF_SSO,
  jaroWinkler,
  MATCH_TIER,
  normalizeExternalRefs,
  QUEUE_THRESHOLD,
  scoreMatch,
  sharesExactRef,
  shouldQueue,
  unionRefs,
} from './matching.js';

describe('normalizeExternalRefs', () => {
  it('folds email / domain sentinels and dedupes, dropping url', () => {
    expect(
      normalizeExternalRefs([
        { connector: IDENTITY_REF_EMAIL, externalId: 'Jane+x@Acme.com' },
        { connector: IDENTITY_REF_EMAIL, externalId: 'jane@acme.com' },
        { connector: 'slack', externalId: 'U1', url: 'https://x' },
      ]),
    ).toEqual([
      { connector: IDENTITY_REF_EMAIL, externalId: 'jane@acme.com' },
      { connector: 'slack', externalId: 'U1' },
    ]);
  });
});

describe('deterministicKeys', () => {
  it('orders exact ref → email → sso, and skips domain for a person', () => {
    const keys = deterministicKeys({
      type: 'person',
      externalRefs: [
        { connector: IDENTITY_REF_SSO, externalId: 'sub-9' },
        { connector: IDENTITY_REF_DOMAIN, externalId: 'acme.com' },
        { connector: IDENTITY_REF_EMAIL, externalId: 'jane@acme.com' },
        { connector: 'jira', externalId: 'jsmith' },
      ],
    });
    expect(keys.map((k) => k.tier)).toEqual([
      MATCH_TIER.externalRef,
      MATCH_TIER.email,
      MATCH_TIER.sso,
    ]);
  });
  it('keeps domain for an organization', () => {
    const keys = deterministicKeys({
      type: 'organization',
      externalRefs: [{ connector: IDENTITY_REF_DOMAIN, externalId: 'https://acme.com' }],
    });
    expect(keys).toEqual([
      { connector: IDENTITY_REF_DOMAIN, externalId: 'acme.com', tier: MATCH_TIER.domain },
    ]);
  });
});

describe('unionRefs / sharesExactRef / domainsOf', () => {
  it('unions without duplicates', () => {
    expect(
      unionRefs(
        [{ connector: 'slack', externalId: 'U1' }],
        [
          { connector: 'slack', externalId: 'U1' },
          { connector: 'jira', externalId: 'j1' },
        ],
      ),
    ).toEqual([
      { connector: 'slack', externalId: 'U1' },
      { connector: 'jira', externalId: 'j1' },
    ]);
  });
  it('detects a shared normalized ref', () => {
    expect(
      sharesExactRef(
        [{ connector: IDENTITY_REF_EMAIL, externalId: 'JANE@acme.com' }],
        [{ connector: IDENTITY_REF_EMAIL, externalId: 'jane@acme.com' }],
      ),
    ).toBe(true);
  });
  it('extracts domains from email + domain refs', () => {
    expect(
      [
        ...domainsOf([
          { connector: IDENTITY_REF_EMAIL, externalId: 'jane@acme.com' },
          { connector: IDENTITY_REF_DOMAIN, externalId: 'beta.io' },
        ]),
      ].sort(),
    ).toEqual(['acme.com', 'beta.io']);
  });
});

describe('jaroWinkler', () => {
  it('is 1 for identical, 0 for disjoint', () => {
    expect(jaroWinkler('jane smith', 'jane smith')).toBe(1);
    expect(jaroWinkler('abc', 'xyz')).toBe(0);
  });
  it('handles empty and single-char strings without out-of-bounds', () => {
    expect(jaroWinkler('', '')).toBe(0);
    expect(jaroWinkler('a', '')).toBe(0);
    expect(jaroWinkler('a', 'a')).toBe(1);
    expect(jaroWinkler('a', 'b')).toBe(0);
    expect(jaroWinkler('martha', 'marhta')).toBeGreaterThan(0.9); // classic transposition case
  });
  it('scores a near-duplicate high and a different name low', () => {
    expect(jaroWinkler('jon smith', 'john smith')).toBeGreaterThan(0.9);
    expect(jaroWinkler('jane smith', 'bob jones')).toBeLessThan(0.65);
  });
});

describe('scoreMatch / shouldQueue', () => {
  it('queues a near-duplicate name with a shared org', () => {
    const { score, signals } = scoreMatch({
      nameA: 'jon smith',
      nameB: 'john smith',
      sharedDomain: false,
      sharedOrg: true,
    });
    expect(signals.sharedOrg).toBe(true);
    expect(shouldQueue(score, signals)).toBe(true);
  });
  it('does not queue a clearly different pair', () => {
    const { score, signals } = scoreMatch({
      nameA: 'jane smith',
      nameB: 'bob jones',
      sharedDomain: true,
      sharedOrg: true,
    });
    expect(shouldQueue(score, signals)).toBe(false);
  });
  it('never reaches the auto-merge line on fuzzy signals', () => {
    const { score } = scoreMatch({
      nameA: 'jane smith',
      nameB: 'jane smith',
      sharedDomain: true,
      sharedOrg: true,
    });
    expect(score).toBeLessThan(AUTO_MERGE_THRESHOLD);
  });
  it('honours the threshold boundary', () => {
    const sig = { nameSimilarity: QUEUE_THRESHOLD };
    expect(shouldQueue(QUEUE_THRESHOLD, sig)).toBe(false); // no corroboration, name < 0.9
    expect(shouldQueue(QUEUE_THRESHOLD - 0.01, { ...sig, sharedOrg: true })).toBe(false);
    expect(shouldQueue(QUEUE_THRESHOLD, { ...sig, sharedOrg: true })).toBe(true);
  });
});
