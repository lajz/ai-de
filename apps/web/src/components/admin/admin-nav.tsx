'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['connectors', 'Connectors'],
  ['lineage', 'Lineage'],
  ['graph', 'Graph'],
  ['pipeline', 'Pipeline'],
] as const;

/** Tab bar for the `/admin` section + a link back to the engagement view. */
export function AdminNav({ engagementId }: { engagementId: string }) {
  const pathname = usePathname();
  const base = `/engagements/${engagementId}/admin`;
  return (
    <nav className="admin-nav">
      <Link href={`/engagements/${engagementId}`} className="admin-nav-back">
        ← Engagement
      </Link>
      <span className="admin-nav-tabs">
        {TABS.map(([slug, label]) => {
          const href = `${base}/${slug}`;
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link key={slug} href={href} aria-current={active ? 'page' : undefined}>
              {label}
            </Link>
          );
        })}
      </span>
    </nav>
  );
}
