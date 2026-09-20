'use client';

import Link from 'next/link';
import { useState } from 'react';

import type { Fact, FactPage } from '../lib/types';
import { factTypeColor } from '../lib/type-color';

/**
 * The fact-picker column on `/admin/lineage` — same "server fetches page one,
 * client appends more" split as `FactList`. Scrolls its own bounded-height
 * list (`.lineage-picker` in globals.css); "Load more" appends onto the end
 * of that same scroll area rather than paging to a new view.
 */
export function LineagePicker({
  engagementId,
  initialFacts,
  initialCursor,
  selectedFactId,
}: {
  engagementId: string;
  initialFacts: Fact[];
  initialCursor?: string;
  selectedFactId?: string;
}) {
  const [facts, setFacts] = useState(initialFacts);
  const [cursor, setCursor] = useState(initialCursor);
  const [pending, setPending] = useState(false);

  async function loadMore() {
    if (!cursor) return;
    setPending(true);
    try {
      const qs = new URLSearchParams({ engagementId, cursor });
      const res = await fetch(`/api/facts?${qs}`);
      if (!res.ok) return;
      const page = (await res.json()) as FactPage;
      setFacts((prev) => [...prev, ...page.rows]);
      setCursor(page.nextCursor);
    } finally {
      setPending(false);
    }
  }

  return (
    <ul className="lineage-picker">
      {facts.map((f) => (
        <li key={f.id}>
          <Link
            href={`/engagements/${engagementId}/admin/lineage?factId=${f.id}`}
            aria-current={f.id === selectedFactId ? 'true' : undefined}
          >
            <span className="fact-type" style={{ color: factTypeColor(f.type) }}>
              {f.type}
            </span>{' '}
            {f.summary}
          </Link>
        </li>
      ))}
      {cursor && (
        <li>
          <button type="button" className="btn" onClick={loadMore} disabled={pending}>
            {pending ? 'Loading…' : 'Load more'}
          </button>
        </li>
      )}
    </ul>
  );
}
