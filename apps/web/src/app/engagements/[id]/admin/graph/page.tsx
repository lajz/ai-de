import { AdminError } from '../../../../../components/admin/admin-error';
import { GraphView } from '../../../../../components/admin/graph-view';
import { SignInNotice } from '../../../../../components/sign-in-notice';
import { ApiError, getGraph } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function GraphPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ entityType?: string; predicate?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

  let graph;
  try {
    graph = await getGraph(token, id, filters);
  } catch (err) {
    if (err instanceof ApiError) return <AdminError status={err.status} />;
    throw err;
  }

  return (
    <section>
      <h1>Entity graph</h1>
      {graph.nodes.length === 0 ? (
        <p className="empty-state">No entities or facts match these filters.</p>
      ) : (
        <GraphView engagementId={id} graph={graph} filters={filters} />
      )}
    </section>
  );
}
