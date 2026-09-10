'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Re-runs the server component's data fetch (App Router `router.refresh()`). */
export function RefreshButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);

  return (
    <p className="refresh">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(() => {
            router.refresh();
            setRefreshedAt(new Date().toLocaleTimeString());
          })
        }
      >
        {pending ? 'Refreshing…' : 'Refresh'}
      </button>
      {refreshedAt && <span className="refresh-at"> updated {refreshedAt}</span>}
    </p>
  );
}
