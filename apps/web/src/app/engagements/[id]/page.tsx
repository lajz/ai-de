import Link from 'next/link';

import { AskPanel } from '../../../components/ask-panel';
import { FactList } from '../../../components/fact-list';
import { getFacts, loginUrl } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) {
    return (
      <main>
        <p>
          You are not signed in. <a href={loginUrl()}>Sign in</a>.
        </p>
      </main>
    );
  }

  const facts = await getFacts(token, id);

  return (
    <main>
      <p>
        <Link href="/">← Engagements</Link>
        {' · '}
        <Link href={`/engagements/${id}/admin/connectors`}>Admin</Link>
      </p>
      <h1>Engagement</h1>
      <p>
        <code>{id}</code>
      </p>
      <AskPanel engagementId={id} />
      <h2>Facts</h2>
      <FactList facts={facts} />
    </main>
  );
}
