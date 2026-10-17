import Link from 'next/link';

import { EngagementNav } from '../../../components/engagement-nav';
import { getEngagements } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Display name for the header, falling back to the bare id. This is a
 * display-only lookup — if there's no session or the fetch fails, every
 * page under this layout still does its own real auth check and renders its
 * own `SignInNotice`/`AdminError`; this just degrades to the id alone
 * rather than blocking the page on a header label.
 */
async function engagementLabel(id: string): Promise<string | null> {
  const token = await getSessionToken();
  if (!token) return null;
  try {
    const engagements = await getEngagements(token);
    return engagements.find((e) => e.id === id)?.endCustomerName ?? null;
  } catch {
    return null;
  }
}

export default async function EngagementLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const name = await engagementLabel(id);
  return (
    <main className="engagement">
      <div className="engagement-header">
        <nav className="breadcrumb">
          <Link href="/">← Engagements</Link>
          <span className="breadcrumb-sep" aria-hidden="true">
            /
          </span>
          {name && <span className="engagement-name">{name}</span>}
          <span className="id-chip">{id}</span>
        </nav>
        <EngagementNav engagementId={id} />
      </div>
      <div className="engagement-content">{children}</div>
    </main>
  );
}
