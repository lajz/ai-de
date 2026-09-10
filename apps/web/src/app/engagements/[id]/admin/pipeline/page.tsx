import { AdminError } from '../../../../../components/admin/admin-error';
import { PipelineView } from '../../../../../components/admin/pipeline-view';
import { RefreshButton } from '../../../../../components/admin/refresh-button';
import { SignInNotice } from '../../../../../components/sign-in-notice';
import { ApiError, getPipeline } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function PipelinePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

  let pipeline;
  try {
    pipeline = await getPipeline(token, id);
  } catch (err) {
    if (err instanceof ApiError) return <AdminError status={err.status} />;
    throw err;
  }

  return (
    <section>
      <h1>Pipeline</h1>
      <RefreshButton />
      <PipelineView pipeline={pipeline} />
    </section>
  );
}
