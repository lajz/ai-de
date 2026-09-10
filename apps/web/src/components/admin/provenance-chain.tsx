import Link from 'next/link';

import { relativeTime } from '../../lib/relative-time';
import type { FactProvenance } from '../../lib/types';
import { safeHttpUrl } from '../../lib/url';

function AclChip({ acl }: { acl: FactProvenance['evidence'][number]['acl'] }) {
  if (!acl) return <span className="acl-chip acl-chip-none">no ACL captured</span>;
  const kinds = acl.principalKinds.length ? acl.principalKinds.join(', ') : 'no scopes';
  const ttl = acl.ttlSeconds != null ? ` · ttl ${acl.ttlSeconds}s` : '';
  return (
    <span className="acl-chip">
      {acl.ruleCount} {acl.ruleCount === 1 ? 'rule' : 'rules'} · {kinds}
      {ttl}
    </span>
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
      <article className="prov-fact">
        <div className="prov-fact-head">
          <span className="fact-type">{fact.type}</span>
          <span className="prov-status">{fact.status}</span>
          {fact.confidence != null && (
            <span className="fact-confidence">{Math.round(fact.confidence * 100)}%</span>
          )}
        </div>
        <p className="fact-summary">{fact.summary}</p>
        {fact.body && <p className="fact-body">{fact.body}</p>}
        <p className="prov-dates">
          {fact.occurredAt && <>occurred {relativeTime(fact.occurredAt)} · </>}
          created {relativeTime(fact.createdAt)}
        </p>
      </article>

      <ol className="prov-evidence">
        {evidence.map((ev, i) => {
          const href = safeHttpUrl(ev.source.urlPermalink);
          const span =
            ev.charStart != null && ev.charEnd != null
              ? ` (chars ${ev.charStart}–${ev.charEnd})`
              : '';
          return (
            <li key={`${ev.source.id}-${i}`} className={`prov-ev prov-ev-${ev.relation}`}>
              <div className="prov-ev-quote">
                {ev.quote ? <q>{ev.quote}</q> : <em>quote unavailable</em>}
                <span className="prov-ev-meta">
                  {ev.relation}
                  {span}
                </span>
              </div>
              <div className="prov-source">
                <span className="prov-source-connector">{ev.source.connector}</span>
                <span className="prov-source-kind">{ev.source.kind}</span>
                <span>{relativeTime(ev.source.occurredAt)}</span>
                {href ? (
                  <a href={href} target="_blank" rel="noreferrer">
                    permalink
                  </a>
                ) : (
                  <span className="no-permalink">(no permalink)</span>
                )}
              </div>
              <AclChip acl={ev.acl} />
            </li>
          );
        })}
      </ol>

      <footer className="prov-run">
        {extractionRun ? (
          <>
            extracted by <strong>{extractionRun.model}</strong> · prompt{' '}
            {extractionRun.promptVersion} ·{' '}
            {extractionRun.costUsd != null ? `$${extractionRun.costUsd.toFixed(4)}` : 'cost n/a'} ·{' '}
            {relativeTime(extractionRun.createdAt)}
          </>
        ) : (
          <>no extraction run recorded for this fact</>
        )}
      </footer>

      <p className="prov-graph-link">
        <Link href={`/engagements/${engagementId}/admin/graph`}>View in entity graph →</Link>
      </p>
    </div>
  );
}
