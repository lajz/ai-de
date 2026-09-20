import Link from 'next/link';

import { DecisionMarker } from '../decision-marker';
import { describeAcl } from '../../lib/acl-copy';
import { describeQuoteRelation } from '../../lib/quote-relation';
import { relativeTime } from '../../lib/relative-time';
import type { FactProvenance } from '../../lib/types';
import { factTypeColor } from '../../lib/type-color';
import { SourceBadge } from '../source-badge';

function EvidenceSentence({
  relation,
  quoteRelation,
}: {
  relation: FactProvenance['evidence'][number]['relation'];
  quoteRelation: ReturnType<typeof describeQuoteRelation>;
}) {
  const verb = relation === 'contradicts' ? 'Contradicts' : 'Supports';
  const rest =
    quoteRelation === 'verbatim'
      ? 'quoted directly from the source.'
      : quoteRelation === 'condensed'
        ? 'the extraction condensed this; read the quote above for the exact words.'
        : 'no quote was captured for this evidence.';
  return (
    <p className="prov-ev-sentence">
      <span
        className={relation === 'contradicts' ? 'prov-ev-relation-bad' : 'prov-ev-relation-good'}
      >
        {verb} this fact
      </span>{' '}
      — {rest}
    </p>
  );
}

/** Top-to-bottom render of a fact's provenance: fact → evidence → source → ACL → extraction run. */
export function ProvenanceChain({
  engagementId,
  provenance,
}: {
  engagementId: string;
  provenance: FactProvenance;
}) {
  const { fact, evidence, extractionRun } = provenance;

  return (
    <div className="provenance">
      <section className="prov-section">
        <h2 className="prov-section-label">What was extracted</h2>
        <article className="prov-fact">
          <div className="prov-fact-head">
            <span className="fact-type" style={{ color: factTypeColor(fact.type) }}>
              {fact.type}
            </span>
            <span className="prov-status">{fact.status}</span>
            {fact.confidence != null && (
              <span className="fact-confidence">{Math.round(fact.confidence * 100)}%</span>
            )}
          </div>
          <p className="fact-summary">{fact.summary}</p>
          {fact.body && <p className="fact-body">{fact.body}</p>}
          {fact.type === 'decision' && <DecisionMarker factId={fact.id} />}
          <p className="prov-dates">
            {fact.occurredAt && <>occurred {relativeTime(fact.occurredAt)}, </>}
            created {relativeTime(fact.createdAt)}
          </p>
          <p className="prov-fact-note">
            This is what the extraction produced — see Evidence below for the exact source wording
            it&rsquo;s based on.
          </p>
        </article>
      </section>

      <section className="prov-section">
        <h2 className="prov-section-label">Evidence</h2>
        <ol className="prov-evidence">
          {evidence.map((ev, i) => {
            const span =
              ev.charStart != null && ev.charEnd != null
                ? `chars ${ev.charStart}–${ev.charEnd}`
                : null;
            const quoteRelation = describeQuoteRelation(ev.quote, fact);
            const acl = describeAcl(ev.acl);
            return (
              <li key={`${ev.source.id}-${i}`} className="prov-ev">
                <div className="prov-ev-quote">
                  {ev.quote ? <q>{ev.quote}</q> : <em>quote unavailable</em>}
                </div>
                <EvidenceSentence relation={ev.relation} quoteRelation={quoteRelation} />
                {span && <p className="prov-ev-span">{span}</p>}
                <SourceBadge source={ev.source} />
                <p className="prov-access-summary">{acl.headline}</p>
                <details className="prov-access-detail">
                  <summary>Access rule detail</summary>
                  <p>{acl.detail}</p>
                </details>
              </li>
            );
          })}
        </ol>
      </section>

      <section className="prov-section">
        <h2 className="prov-section-label">How this was extracted</h2>
        <footer className="prov-run">
          {extractionRun ? (
            <dl className="prov-run-meta">
              <dt>extracted by</dt>
              <dd className="mono">{extractionRun.model}</dd>
              <dt>prompt</dt>
              <dd className="mono">{extractionRun.promptVersion}</dd>
              <dt>cost</dt>
              <dd>
                {extractionRun.costUsd != null ? `$${extractionRun.costUsd.toFixed(4)}` : 'n/a'}
              </dd>
              <dt>when</dt>
              <dd>{relativeTime(extractionRun.createdAt)}</dd>
            </dl>
          ) : (
            <p>no extraction run recorded for this fact</p>
          )}
        </footer>
      </section>

      <p className="prov-graph-link">
        <Link href={`/engagements/${engagementId}/admin/graph`}>View in entity graph</Link>
      </p>
    </div>
  );
}
