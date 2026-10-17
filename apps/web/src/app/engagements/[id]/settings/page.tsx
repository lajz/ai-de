import { AdminError } from '../../../../components/admin/admin-error';
import { ConnectorCard } from '../../../../components/admin/connector-card';
import { DangerZone } from '../../../../components/admin/danger-zone';
import { KeyManagementPanel } from '../../../../components/admin/key-management-panel';
import { SignInNotice } from '../../../../components/sign-in-notice';
import { ApiError, getConnectors, getEngagements } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

export const dynamic = 'force-dynamic';

/**
 * Settings bundles connectors config, BYOK key management and the
 * crypto-shred danger zone — genuinely admin-only, rare actions that still
 * belong one click from the engagement rather than nested under their own
 * sub-nav. Kept to a single page (not separate tabs) since none of these
 * three warrant their own top-level slot in the flat tab bar.
 */
export default async function SettingsPage({ params }: { params: Promise<{ id: string }> }) {
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

  let engagement;
  try {
    const engagements = await getEngagements(token);
    engagement = engagements.find((e) => e.id === id);
  } catch (err) {
    if (err instanceof ApiError) return <AdminError status={err.status} />;
    throw err;
  }

  if (!engagement) return <AdminError status={404} />;

  return (
    <section className="engagement-narrow">
      <h1>Settings</h1>

      <h2>Connectors</h2>
      {connectors.length === 0 ? (
        <p className="empty-state">No connectors are registered.</p>
      ) : (
        <ul className="connector-list">
          {connectors.map((c) => (
            <ConnectorCard key={c.connector} engagementId={id} connector={c} />
          ))}
        </ul>
      )}

      <h2>Key management</h2>
      <KeyManagementPanel engagementId={id} initialByokKeyArn={engagement.byokKeyArn} />

      <h2>Danger Zone</h2>
      <DangerZone
        engagementId={id}
        endCustomerName={engagement.endCustomerName}
        initialStatus={engagement.status}
      />
    </section>
  );
}
