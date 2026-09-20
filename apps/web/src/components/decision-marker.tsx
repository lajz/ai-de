'use client';

import { useState } from 'react';

/**
 * `fde:decision:<factId>` — the literal marker text a Linear issue or GitHub PR
 * description references to produce a `(decision)-[implemented_by]->(work_item)`
 * edge (see `packages/connectors/src/decision-marker.ts`). Shown only for
 * `type === 'decision'` facts, with a copy button so a human doesn't have to
 * hand-type a UUID into a ticket description.
 */
export function DecisionMarker({ factId }: { factId: string }) {
  const [copied, setCopied] = useState(false);
  const marker = `fde:decision:${factId}`;

  return (
    <p className="decision-marker">
      <code className="mono">{marker}</code>
      <button
        type="button"
        className="btn"
        onClick={() => {
          navigator.clipboard
            .writeText(marker)
            .then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
            .catch(() => {
              // clipboard access can be denied (permissions, insecure context) — the
              // marker text above is still visible to select and copy by hand
            });
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </p>
  );
}
