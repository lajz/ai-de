import Link from 'next/link';

import { EngagementNav } from '../../../components/engagement-nav';

export const dynamic = 'force-dynamic';

export default async function EngagementLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="engagement">
      <nav className="breadcrumb">
        <Link href="/">← Engagements</Link>
        <span className="breadcrumb-sep" aria-hidden="true">
          /
        </span>
        <span className="id-chip">{id}</span>
      </nav>
      <EngagementNav engagementId={id} />
      {children}
    </main>
  );
}
