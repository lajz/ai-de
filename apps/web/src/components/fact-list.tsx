'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { CSSProperties } from 'react';

import type { Fact, FactPage } from '../lib/types';
import { DecisionMarker } from './decision-marker';
import { describeQuoteRelation } from '../lib/quote-relation';
import { factTypeColor } from '../lib/type-color';
import { safeHttpUrl } from '../lib/url';

/**
 * Read-only render of an engagement's extracted facts + their source
 * citations, paged via `/api/facts` — the server component that renders this
 * fetches the first page (`initialFacts`/`initialCursor`), and "Load more"
 * appends subsequent pages client-side. Every card links onward to that
 * fact's full provenance chain (`/admin/lineage?factId=`) — the citation here
 * is just the quote + a permalink; the chain has the ACL summary and
 * extraction run too, and is reachable from any viewer, not only an admin role.
 */
export function FactList({
  engagementId,
  initialFacts,
  initialCursor,
}: {
  engagementId: string;
  initialFacts: Fact[];
  initialCursor?: string;
}) {
  const [facts, setFacts] = useState(initialFacts);
  const [cursor, setCursor] = useState(initialCursor);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    if (!cursor) return;
    setPending(true);
    setError(null);
    try {
      const qs = new URLSearchParams({ engagementId, cursor });
      const res = await fetch(`/api/facts?${qs}`);
      if (!res.ok) throw new Error(`request failed (${res.status})`);
      const page = (await res.json()) as FactPage;
      setFacts((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'request failed');
    } finally {
      setPending(false);
    }
  }

  if (facts.length === 0) {
    return <p className="empty-state">No facts extracted for this engagement yet.</p>;
  }

  return (
    <>
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
            {fact.type === 'decision' && <DecisionMarker factId={fact.id} />}
            {fact.citations.length > 0 && (
              <ul className="citations">
                {fact.citations.map((c, i) => {
                  const href = safeHttpUrl(c.permalink);
                  const relation = describeQuoteRelation(c.quote, fact);
                  return (
                    <li key={`${fact.id}-${i}`} className="citation">
                      {c.quote && (
                        <p className="citation-relation">
                          {relation === 'verbatim'
                            ? 'Quoted directly from the source:'
                            : 'The extraction condensed this from the source:'}
                        </p>
                      )}
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
      {cursor && (
        <button type="button" className="btn" onClick={loadMore} disabled={pending}>
          {pending ? 'Loading…' : 'Load more'}
        </button>
      )}
      {error && <p role="alert">{error}</p>}
    </>
  );
}
