import type { CSSProperties } from 'react';

import type { Fact } from '../lib/types';
import { factTypeColor } from '../lib/type-color';
import { safeHttpUrl } from '../lib/url';

/** Read-only render of an engagement's extracted facts + their source citations. */
export function FactList({ facts }: { facts: Fact[] }) {
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
        </li>
      ))}
    </ul>
  );
}
