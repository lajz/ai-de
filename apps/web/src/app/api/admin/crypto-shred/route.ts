import { NextResponse } from 'next/server';

import { ApiError, cryptoShredEngagement } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

const CRYPTO_SHRED_ERROR_MESSAGES: Record<number, string> = {
  403: 'not authorized to crypto-shred this engagement',
  404: 'engagement not found',
};

/**
 * Same-origin proxy for `POST /engagements/:id/crypto-shred`. Irreversible —
 * the upstream route destroys the engagement's data-encryption key
 * synchronously, so a 200 here means the shred already happened.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, reason } = (body ?? {}) as { engagementId?: unknown; reason?: unknown };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof reason !== 'string' || reason.trim() === '') {
    return NextResponse.json({ error: 'reason must be a non-empty string' }, { status: 400 });
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await cryptoShredEngagement(token, engagementId, reason));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(`POST /api/admin/crypto-shred → upstream ${status}: ${(err as Error).message}`);
    return NextResponse.json(
      { error: CRYPTO_SHRED_ERROR_MESSAGES[status] ?? 'upstream request failed' },
      { status },
    );
  }
}
