import Link from 'next/link';

import { AdminError } from '../../../../../components/admin/admin-error';
import { ProvenanceChain } from '../../../../../components/admin/provenance-chain';
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

  let facts;
  try {
    facts = await getFacts(token, id);
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
      <ul className="lineage-picker">
        {facts.map((f) => (
          <li key={f.id}>
            <Link
              href={`/engagements/${id}/admin/lineage?factId=${f.id}`}
              aria-current={f.id === factId ? 'true' : undefined}
            >
              <span className="fact-type">{f.type}</span> {f.summary}
            </Link>
          </li>
        ))}
      </ul>

      {!factId && <p>Pick a fact above to trace its provenance.</p>}
      {provenanceError != null && <AdminError status={provenanceError} />}
      {provenance && <ProvenanceChain engagementId={id} provenance={provenance} />}
    </section>
  );
}
