import { AdminError } from '../../../../../components/admin/admin-error';
import { ProvenanceChain } from '../../../../../components/admin/provenance-chain';
import { LineagePicker } from '../../../../../components/lineage-picker';
import { SignInNotice } from '../../../../../components/sign-in-notice';
import { ApiError, getFactProvenance, getFacts } from '../../../../../lib/api';
import { getSessionToken } from '../../../../../lib/session';

export const dynamic = 'force-dynamic';

export default async function LineagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ factId?: string }>;
}) {
  const { id } = await params;
  const { factId } = await searchParams;
  const token = await getSessionToken();
  if (!token) return <SignInNotice />;

  let factPage;
  try {
    factPage = await getFacts(token, id);
  } catch (err) {
    if (err instanceof ApiError) return <AdminError status={err.status} />;
    throw err;
  }

  let provenance = null;
  let provenanceError: number | null = null;
  if (factId) {
    try {
      provenance = await getFactProvenance(token, id, factId);
    } catch (err) {
      if (err instanceof ApiError) provenanceError = err.status;
      else throw err;
    }
  }

  return (
    <section>
      <h1>Lineage</h1>
      <div className="lineage-layout">
        <LineagePicker
          engagementId={id}
          initialFacts={factPage.rows}
          initialCursor={factPage.nextCursor}
          selectedFactId={factId}
        />

        <div className="lineage-detail">
          {!factId && <p className="empty-state">Pick a fact to trace its provenance.</p>}
          {provenanceError != null && <AdminError status={provenanceError} />}
          {provenance && <ProvenanceChain engagementId={id} provenance={provenance} />}
        </div>
      </div>
    </section>
  );
}
