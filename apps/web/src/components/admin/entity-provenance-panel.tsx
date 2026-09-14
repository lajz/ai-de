'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import type { EntityDerivation, EntityProvenance } from '../../lib/types';
import { SourceBadge } from '../source-badge';

export type EntityProvenanceLoadState =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: EntityProvenance };

function humanizePredicate(predicate: string): string {
  return predicate.replace(/_/g, ' ');
}

function DerivationSentence({
  entityLabel,
  derivation,
  counterpartNode,
}: {
  entityLabel: string;
  derivation: EntityDerivation;
  counterpartNode: ReactNode;
}) {
  const predicate = (
    <span className="entity-derivation-predicate-word">
      {humanizePredicate(derivation.predicate)}
    </span>
  );
  return (
    <p className="entity-derivation-sentence">
      {derivation.direction === 'outgoing' ? (
        <>
          <strong>{entityLabel}</strong> {predicate} {counterpartNode}
        </>
      ) : (
        <>
          {counterpartNode} {predicate} <strong>{entityLabel}</strong>
        </>
      )}{' '}
      <span className="entity-derivation-predicate-raw mono">{derivation.predicate}</span>
    </p>
  );
}

/**
 * Pure render of the panel body for a given load state — split out from
 * `EntityProvenancePanel` so the loading/error/empty/ready states (incl. the
 * outgoing/incoming derivation prose) are testable via `renderToStaticMarkup`
 * without needing a DOM/fetch harness for the surrounding effect.
 */
export function EntityProvenanceView({
  engagementId,
  entityLabel,
  state,
}: {
  engagementId: string;
  entityLabel: string;
  state: EntityProvenanceLoadState;
}) {
  if (state.status === 'loading') {
    return (
      <div>
        <h2 className="prov-section-label">Derived from</h2>
        <p className="entity-derivations-status">Loading derivation…</p>
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div>
        <h2 className="prov-section-label">Derived from</h2>
        <p className="entity-derivations-status" role="alert">
          Could not load how this entity was derived.
        </p>
      </div>
    );
  }

  const { derivedFrom, facts } = state.data;
  if (derivedFrom.length === 0) {
    return (
      <div>
        <h2 className="prov-section-label">Derived from</h2>
        <p className="entity-derivations-status">No single-source derivation recorded.</p>
      </div>
    );
  }

  const factById = new Map(facts.map((f) => [f.id, f]));

  return (
    <div>
      <h2 className="prov-section-label">Derived from</h2>
      <ul className="entity-derivations">
        {derivedFrom.map((d) => {
          const fact = d.counterpart.kind === 'fact' ? factById.get(d.counterpart.id) : undefined;
          const counterpartNode = fact ? (
            <Link href={`/engagements/${engagementId}/admin/lineage?factId=${fact.id}`}>
              {fact.type}: {fact.summary}
            </Link>
          ) : (
            <span className="entity-derivation-counterpart mono">
              {d.counterpart.kind} {d.counterpart.id}
            </span>
          );
          return (
            <li key={d.relationshipId} className="entity-derivation">
              <DerivationSentence
                entityLabel={entityLabel}
                derivation={d}
                counterpartNode={counterpartNode}
              />
              <SourceBadge source={d.source} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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
  entityLabel,
}: {
  engagementId: string;
  entityId: string;
  entityLabel: string;
}) {
  const [state, setState] = useState<EntityProvenanceLoadState>({ status: 'loading' });

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

  return (
    <EntityProvenanceView engagementId={engagementId} entityLabel={entityLabel} state={state} />
  );
}
