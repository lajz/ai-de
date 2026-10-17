import { AskPanel } from '../../../components/ask-panel';
import { FactsPane } from '../../../components/facts-pane';
import { SignInNotice } from '../../../components/sign-in-notice';
import { getFacts } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function EngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

  const factPage = await getFacts(token, id);

  return (
    <div className="engagement-split">
      <div className="engagement-split-chat">
        <AskPanel engagementId={id} />
      </div>
      <FactsPane
        engagementId={id}
        initialFacts={factPage.rows}
        initialCursor={factPage.nextCursor}
      />
    </div>
  );
}
