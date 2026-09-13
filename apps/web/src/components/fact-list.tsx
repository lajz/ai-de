import Link from 'next/link';
import type { CSSProperties } from 'react';

import type { Fact } from '../lib/types';
import { factTypeColor } from '../lib/type-color';
import { safeHttpUrl } from '../lib/url';

/**
 * Read-only render of an engagement's extracted facts + their source
 * citations. Every card links onward to that fact's full provenance chain
 * (`/admin/lineage?factId=`) — the citation here is just the quote + a
 * permalink; the chain has the ACL summary and extraction run too, and is
 * reachable from any viewer, not only an admin role.
 */
export function FactList({ engagementId, facts }: { engagementId: string; facts: Fact[] }) {
  if (facts.length === 0) {
    return <p className="empty-state">No facts extracted for this engagement yet.</p>;
  }

  return (
    <ul className="facts">
      {facts.map((fact) => (
        <li
          key={fact.id}
          className="fact"
          style={{ '--fact-color': factTypeColor(fact.type) } as CSSProperties}
        >
          <div className="fact-head">
            <span className="fact-type">{fact.type}</span>
            {fact.confidence != null && (
              <span className="fact-confidence">{Math.round(fact.confidence * 100)}%</span>
            )}
          </div>
          <p className="fact-summary">{fact.summary}</p>
          {fact.body && <p className="fact-body">{fact.body}</p>}
          {fact.citations.length > 0 && (
            <ul className="citations">
              {fact.citations.map((c, i) => {
                const href = safeHttpUrl(c.permalink);
                return (
                  <li key={`${fact.id}-${i}`} className="citation">
                    {c.quote && <q>{c.quote}</q>}{' '}
                    {href ? (
                      <a href={href} target="_blank" rel="noreferrer">
                        source
                      </a>
                    ) : (
                      <span className="no-permalink">(no permalink)</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="fact-foot">
            <Link href={`/engagements/${engagementId}/admin/lineage?factId=${fact.id}`}>
              Full provenance
            </Link>
          </p>
        </li>
      ))}
    </ul>
  );
}
