import { AdminError } from '../../../../../components/admin/admin-error';
import { ConnectorCard } from '../../../../../components/admin/connector-card';
import { SignInNotice } from '../../../../../components/sign-in-notice';
import { ApiError, getConnectors } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function ConnectorsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

  let connectors;
  try {
    connectors = await getConnectors(token, id);
  } catch (err) {
    if (err instanceof ApiError) return <AdminError status={err.status} />;
    throw err;
  }

  return (
    <section>
      <h1>Connectors</h1>
      {connectors.length === 0 ? (
        <p>No connectors are registered.</p>
      ) : (
        <ul className="connector-list">
          {connectors.map((c) => (
            <ConnectorCard key={c.connector} engagementId={id} connector={c} />
          ))}
        </ul>
      )}
    </section>
  );
}
