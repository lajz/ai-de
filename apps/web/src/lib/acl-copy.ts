import type { AclSummary } from './types';

/**
 * Plain-language framing of an ACL snapshot for readers who shouldn't have
 * to parse "principal kinds" or "ttl" — a headline sentence for the main
 * view, and a precise raw sentence (exact counts/kinds/ttl) for anyone who
 * wants it, meant to sit behind a `<details>`.
 */
export interface AclCopy {
  headline: string;
  detail: string;
}

const KNOWN_KINDS: Record<string, string> = {
  granola_workspace: 'everyone in that Granola workspace',
  linear_workspace: 'everyone in that Linear workspace',
};

function humanizeKind(kind: string): string {
  const known = KNOWN_KINDS[kind];
  if (known) return known;
  return `members of that ${kind.replace(/_/g, ' ')}`;
}

function joinPlain(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

export function describeAcl(acl: AclSummary | null): AclCopy {
  if (!acl) {
    return {
      headline: "Who could see this wasn't recorded.",
      detail: 'no ACL snapshot captured',
    };
  }

  const ttlSuffix = acl.ttlSeconds != null ? `, expires ${acl.ttlSeconds}s after capture` : '';

  if (acl.ruleCount === 0) {
    return {
      headline: "No extra access rule beyond the engagement's own membership.",
      detail: `0 access rules captured for this source; access is governed by engagement membership only${ttlSuffix}`,
    };
  }

  const kinds = acl.principalKinds.length ? acl.principalKinds : ['no scopes'];
  const headline = `Visible to ${joinPlain(kinds.map(humanizeKind))}.`;
  const ruleWord = acl.ruleCount === 1 ? 'rule' : 'rules';
  const detail = `${acl.ruleCount} ${ruleWord} for ${kinds.join(', ')}${ttlSuffix}`;

  return { headline, detail };
}
