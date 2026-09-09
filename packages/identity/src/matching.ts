import type { ExternalRef } from '@fde/core';
import type { MatchSignals } from '@fde/db';

import { normalizeDomain, normalizeEmail } from './normalize.js';

/**
 * Sentinel `externalRef.connector` values that carry a deterministic identity key
 * rather than a real origin-system ref. Connectors emit these alongside the
 * normal `{connector, externalId}` refs in `normalize`; `resolveEntity` matches
 * on them in priority order.
 */
export const IDENTITY_REF_EMAIL = 'fde:email';
export const IDENTITY_REF_SSO = 'fde:sso';
export const IDENTITY_REF_DOMAIN = 'fde:domain';

/** Deterministic match tiers, lowest number = highest priority. */
export const MATCH_TIER = {
  externalRef: 1,
  email: 2,
  sso: 3,
  domain: 4,
} as const;

export type MatchKind = keyof typeof MATCH_TIER;

const TIER_KIND: Record<number, MatchKind> = {
  1: 'externalRef',
  2: 'email',
  3: 'sso',
  4: 'domain',
};

export function tierKind(tier: number): MatchKind {
  return TIER_KIND[tier]!;
}

const refKey = (r: { connector: string; externalId: string }) =>
  `${JSON.stringify([r.connector, r.externalId])}`;

/**
 * Normalize a canonical entity's `externalRefs`: fold the `fde:email` /
 * `fde:domain` sentinels through their normalizers, drop `url`, dedupe. Order is
 * preserved (first occurrence wins).
 */
export function normalizeExternalRefs(refs: readonly ExternalRef[]): ExternalRef[] {
  const seen = new Set<string>();
  const out: ExternalRef[] = [];
  for (const r of refs) {
    let externalId = r.externalId.trim();
    if (r.connector === IDENTITY_REF_EMAIL) externalId = normalizeEmail(externalId);
    else if (r.connector === IDENTITY_REF_DOMAIN) externalId = normalizeDomain(externalId);
    if (!externalId) continue;
    const ref: ExternalRef = { connector: r.connector, externalId };
    if (seen.has(refKey(ref))) continue;
    seen.add(refKey(ref));
    out.push(ref);
  }
  return out;
}

/** `a ∪ b` over normalized refs, `a`'s order first. */
export function unionRefs(a: readonly ExternalRef[], b: readonly ExternalRef[]): ExternalRef[] {
  const merged = normalizeExternalRefs(a);
  const have = new Set(merged.map(refKey));
  for (const r of normalizeExternalRefs(b)) {
    if (!have.has(refKey(r))) {
      have.add(refKey(r));
      merged.push(r);
    }
  }
  return merged;
}

/** True when the two ref sets share any normalized `{connector, externalId}`. */
export function sharesExactRef(a: readonly ExternalRef[], b: readonly ExternalRef[]): boolean {
  const have = new Set(normalizeExternalRefs(a).map(refKey));
  return normalizeExternalRefs(b).some((r) => have.has(refKey(r)));
}

export interface DeterministicKey {
  connector: string;
  externalId: string;
  /** `MATCH_TIER` value */
  tier: number;
}

/**
 * The deterministic lookup keys for a canonical entity, in priority order:
 * exact origin ref → email → SSO subject → (organization) domain.
 */
export function deterministicKeys(entity: {
  type: string;
  externalRefs: readonly ExternalRef[];
}): DeterministicKey[] {
  const keys: DeterministicKey[] = [];
  for (const ref of normalizeExternalRefs(entity.externalRefs)) {
    if (ref.connector === IDENTITY_REF_EMAIL) {
      keys.push({ ...ref, tier: MATCH_TIER.email });
    } else if (ref.connector === IDENTITY_REF_SSO) {
      keys.push({ ...ref, tier: MATCH_TIER.sso });
    } else if (ref.connector === IDENTITY_REF_DOMAIN) {
      if (entity.type === 'organization') keys.push({ ...ref, tier: MATCH_TIER.domain });
    } else {
      keys.push({ ...ref, tier: MATCH_TIER.externalRef });
    }
  }
  return keys.sort((x, y) => x.tier - y.tier);
}

/** Normalized email domains reachable from a ref set (`fde:domain` + `fde:email`). */
export function domainsOf(refs: readonly ExternalRef[]): Set<string> {
  const out = new Set<string>();
  for (const r of normalizeExternalRefs(refs)) {
    if (r.connector === IDENTITY_REF_DOMAIN) out.add(r.externalId);
    else if (r.connector === IDENTITY_REF_EMAIL) {
      const at = r.externalId.lastIndexOf('@');
      if (at > 0) out.add(r.externalId.slice(at + 1));
    }
  }
  return out;
}

/**
 * Jaro-Winkler similarity, 0–1. Dependency-light; adequate for short person /
 * org names. `prefixScale` 0.1 with a 4-char prefix cap is the standard tuning.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions) / m) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Below this, a name pair is "clearly different" and never queued. At or above it
 * (and below `AUTO_MERGE_THRESHOLD`) the pair goes to the human-review queue.
 */
export const QUEUE_THRESHOLD = 0.84;

/**
 * v1 has NO fuzzy auto-merge — only deterministic keys merge automatically. The
 * scorer caps below this line so a fuzzy score can never trip an auto-merge a
 * later version might add.
 */
export const AUTO_MERGE_THRESHOLD = 1;

export interface ScoreInput {
  /** `normalizeName`-folded display names */
  nameA: string;
  nameB: string;
  sharedDomain: boolean;
  sharedOrg: boolean;
}

/**
 * Combine name similarity with corroborating signals into a 0–0.99 score.
 * A shared org / email domain nudges a borderline name pair over the line; it
 * cannot by itself carry a dissimilar pair there.
 */
export function scoreMatch(input: ScoreInput): { score: number; signals: MatchSignals } {
  const nameSimilarity = jaroWinkler(input.nameA, input.nameB);
  let score = nameSimilarity;
  if (input.sharedDomain) score += 0.05;
  if (input.sharedOrg) score += 0.05;
  score = Math.min(score, 0.99);
  return {
    score,
    signals: {
      nameSimilarity,
      sharedDomain: input.sharedDomain,
      sharedOrg: input.sharedOrg,
    },
  };
}

/** Whether a scored pair belongs in the review queue (never an auto-merge in v1). */
export function shouldQueue(score: number, signals: MatchSignals): boolean {
  if (score >= AUTO_MERGE_THRESHOLD) return false;
  if (score < QUEUE_THRESHOLD) return false;
  // a very close name stands on its own; a merely similar one needs corroboration
  return (signals.nameSimilarity ?? 0) >= 0.9 || !!signals.sharedDomain || !!signals.sharedOrg;
}
