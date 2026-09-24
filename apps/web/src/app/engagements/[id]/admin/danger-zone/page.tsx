import { AdminError } from '../../../../../components/admin/admin-error';
import { DangerZone } from '../../../../../components/admin/danger-zone';
import { KeyManagementPanel } from '../../../../../components/admin/key-management-panel';
import { SignInNotice } from '../../../../../components/sign-in-notice';
import { ApiError, getEngagements } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function DangerZonePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

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
    <section>
      <h2>Key management</h2>
      <KeyManagementPanel engagementId={id} initialByokKeyArn={engagement.byokKeyArn} />

      <h1>Danger Zone</h1>
      <DangerZone
        engagementId={id}
        endCustomerName={engagement.endCustomerName}
        initialStatus={engagement.status}
      />
    </section>
  );
}
