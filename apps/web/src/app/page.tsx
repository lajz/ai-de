import Link from 'next/link';

import { SignInNotice } from '../components/sign-in-notice';
import { getEngagements } from '../lib/api';
import { getSessionToken } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const token = await getSessionToken();
  if (!token) {
    return (
      <main>
        <h1>Engagements</h1>
        <SignInNotice />
      </main>
    );
  }

  const engagements = await getEngagements(token);

  return (
    <main>
      <h1>Engagements</h1>
      {engagements.length === 0 ? (
        <p className="empty-state">No engagements are visible to you.</p>
      ) : (
        <ul className="engagement-list">
          {engagements.map((e) => (
            <li key={e.id} className="engagement-row">
              <Link href={`/engagements/${e.id}`}>
                <span className="engagement-name">{e.endCustomerName}</span>
                <span className="engagement-region">{e.regionPin}</span>
                <span className="pill">
                  <span className={`status-dot status-dot-${e.status}`} aria-hidden="true" />
                  {e.status}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
