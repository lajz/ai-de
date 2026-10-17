'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const TABS = [
  ['', 'Ask'],
  ['lineage', 'Lineage'],
  ['graph', 'Graph'],
  ['pipeline', 'Pipeline'],
] as const;

/**
 * Flat tab bar for every `/engagements/[id]/...` page — Ask, Lineage, Graph
 * and Pipeline sit directly on the engagement, with a quieter trailing
 * Settings tab (connectors + BYOK + danger zone) that's one click away but
 * visually de-emphasized since it's reached deliberately, not by default.
 */
export function EngagementNav({ engagementId }: { engagementId: string }) {
  const pathname = usePathname();
  const base = `/engagements/${engagementId}`;
  const settingsHref = `${base}/settings`;
  const settingsActive = pathname === settingsHref || pathname.startsWith(`${settingsHref}/`);

  return (
    <nav className="engagement-nav">
      <span className="engagement-nav-tabs">
        {TABS.map(([slug, label]) => {
          const href = slug ? `${base}/${slug}` : base;
          const active = slug
            ? pathname === href || pathname.startsWith(`${href}/`)
            : pathname === base;
          return (
            <Link key={slug || 'ask'} href={href} aria-current={active ? 'page' : undefined}>
              {label}
            </Link>
          );
        })}
      </span>
      <Link
        href={settingsHref}
        className="engagement-nav-settings"
        aria-current={settingsActive ? 'page' : undefined}
      >
        <span aria-hidden="true">⚙</span> Settings
      </Link>
    </nav>
  );
}
