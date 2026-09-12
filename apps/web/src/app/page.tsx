import Link from 'next/link';

import { SignInNotice } from '../components/sign-in-notice';
import { ApiError, getEngagements } from '../lib/api';
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

  let engagements;
  try {
    engagements = await getEngagements(token);
  } catch (err) {
    // `@fde/api`'s session store is in-memory: any api restart (a hot-reload
    // in dev, a redeploy in prod) invalidates every session, leaving a
    // `fde_session` cookie in the browser that no longer resolves to
    // anything. Treat that the same as "not signed in" rather than crashing —
    // any other status is a real failure and should still surface as one.
    if (err instanceof ApiError && err.status === 401) {
      return (
        <main>
          <h1>Engagements</h1>
          <SignInNotice />
        </main>
      );
    }
    throw err;
  }

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
