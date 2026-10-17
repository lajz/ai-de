'use client';

import { useState } from 'react';

import type { Fact } from '../lib/types';
import { FactList } from './fact-list';

/**
 * The Facts side of the Ask/Facts split — wraps `FactList` with a
 * collapse/expand toggle, since the pane's own width is local state that
 * doesn't need to be known by `AskPanel`: when collapsed, this pane shrinks
 * to a narrow rail and the chat pane fills the freed space automatically
 * (both panes are `flex: 1 1 0` siblings — see `.engagement-split` in
 * `globals.css` — so there's nothing to coordinate between them).
 */
export function FactsPane({
  engagementId,
  initialFacts,
  initialCursor,
}: {
  engagementId: string;
  initialFacts: Fact[];
  initialCursor?: string;
}) {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className="engagement-split-facts engagement-split-facts-collapsed">
        <button
          type="button"
          className="facts-collapse-toggle"
          onClick={() => setCollapsed(false)}
          aria-label="Expand facts"
          title="Expand facts"
        >
          ‹
        </button>
      </div>
    );
  }

  return (
    <div className="engagement-split-facts">
      <div className="ask-head">
        <h2>Facts</h2>
        <button
          type="button"
          className="facts-collapse-toggle"
          onClick={() => setCollapsed(true)}
          aria-label="Collapse facts"
          title="Collapse facts"
        >
          ›
        </button>
      </div>
      <FactList
        engagementId={engagementId}
        initialFacts={initialFacts}
        initialCursor={initialCursor}
      />
    </div>
  );
}
