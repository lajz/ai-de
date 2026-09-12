'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import type { EntityProvenance } from '../../lib/types';
import { SourceBadge } from '../source-badge';

type LoadState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: EntityProvenance };

/**
 * The "derived from" detail for one entity node in the graph: every
 * single-artifact-attested `relationships` edge touching it, the source that
 * attested it, and — for fact counterparts — a link onward into that fact's
 * own provenance chain. This is the graph panel's primary content for an
 * entity node; the raw `externalRefs` a technical user might still want live
 * behind a `<details>` in the caller.
 */
export function EntityProvenancePanel({
  engagementId,
  entityId,
}: {
  engagementId: string;
  entityId: string;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const qs = new URLSearchParams({ engagementId, entityId });
    fetch(`/api/admin/entity-provenance?${qs}`)
      .then((res) => {
        if (!res.ok) throw new Error(`request failed (${res.status})`);
        return res.json() as Promise<EntityProvenance>;
      })
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [engagementId, entityId]);

  if (state.status === 'loading') {
    return <p className="entity-derivations-status">Loading derivation…</p>;
  }
  if (state.status === 'error') {
    return (
      <p className="entity-derivations-status" role="alert">
        Could not load how this entity was derived.
      </p>
    );
  }

  const { derivedFrom, facts } = state.data;
  if (derivedFrom.length === 0) {
    return <p className="entity-derivations-status">No single-source derivation recorded.</p>;
  }

  const factById = new Map(facts.map((f) => [f.id, f]));

  return (
    <ul className="entity-derivations">
      {derivedFrom.map((d) => {
        const fact = d.counterpart.kind === 'fact' ? factById.get(d.counterpart.id) : undefined;
        return (
          <li key={d.relationshipId} className="entity-derivation">
            <div className="entity-derivation-head">
              <span className="entity-derivation-predicate">{d.predicate}</span>
              <span className="entity-derivation-direction">
                {d.direction === 'outgoing' ? 'to' : 'from'}
              </span>
              {fact ? (
                <Link href={`/engagements/${engagementId}/admin/lineage?factId=${fact.id}`}>
                  {fact.type}: {fact.summary}
                </Link>
              ) : (
                <span className="entity-derivation-counterpart">
                  {d.counterpart.kind} {d.counterpart.id}
                </span>
              )}
            </div>
            <SourceBadge source={d.source} />
          </li>
        );
      })}
    </ul>
  );
}
