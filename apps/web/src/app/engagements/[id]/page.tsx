import Link from 'next/link';

import { AskPanel } from '../../../components/ask-panel';
import { FactList } from '../../../components/fact-list';
import { SignInNotice } from '../../../components/sign-in-notice';
import { getFacts } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) {
    return (
      <main>
        <h1>Engagement</h1>
        <SignInNotice />
      </main>
    );
  }

  const factPage = await getFacts(token, id);

  return (
    <main>
      <nav className="breadcrumb">
        <Link href="/">← Engagements</Link>
        <span className="breadcrumb-sep" aria-hidden="true">
          /
        </span>
        <Link href={`/engagements/${id}/admin/connectors`}>Admin</Link>
      </nav>
      <h1>Engagement</h1>
      <p>
        <span className="id-chip">{id}</span>
      </p>
      <div className="engagement-split">
        <div className="engagement-split-chat">
          <AskPanel engagementId={id} />
        </div>
        <div className="engagement-split-facts">
          <h2>Facts</h2>
          <FactList
            engagementId={id}
            initialFacts={factPage.rows}
            initialCursor={factPage.nextCursor}
          />
        </div>
      </div>
    </main>
  );
}
