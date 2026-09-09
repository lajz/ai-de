import Link from 'next/link';

import { getEngagements, loginUrl } from '../lib/api';
import { getSessionToken } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const token = await getSessionToken();
  if (!token) {
    return (
      <main>
        <h1>FDE Context</h1>
        <p>
          You are not signed in. <a href={loginUrl()}>Sign in</a>.
        </p>
      </main>
    );
  }

  const engagements = await getEngagements(token);

  return (
    <main>
      <h1>Engagements</h1>
      {engagements.length === 0 ? (
        <p>No engagements visible to you.</p>
      ) : (
        <ul className="engagements">
          {engagements.map((e) => (
            <li key={e.id}>
              <Link href={`/engagements/${e.id}`}>{e.endCustomerName}</Link>{' '}
              <small>
                {e.regionPin} · {e.status}
              </small>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
