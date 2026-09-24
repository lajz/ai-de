import { NextResponse } from 'next/server';

import { ApiError, setByokKey } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

const SET_BYOK_KEY_ERROR_MESSAGES: Record<number, string> = {
  403: "not authorized to manage this engagement's keys",
  404: 'engagement not found',
  410: 'engagement is crypto-shredded',
};

/**
 * Same-origin proxy for `POST /engagements/:id/crypto/byok-key`. A 200 here
 * means the engagement's DEK has already been re-wrapped under the supplied
 * key — a bad ARN or a not-yet-propagated cross-account grant comes back as a
 * 400 with the upstream detail (see the API route's doc comment), never a
 * silently-broken engagement.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, byokKeyArn } = (body ?? {}) as {
    engagementId?: unknown;
    byokKeyArn?: unknown;
  };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof byokKeyArn !== 'string' || byokKeyArn.trim() === '') {
    return NextResponse.json({ error: 'byokKeyArn must be a non-empty string' }, { status: 400 });
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await setByokKey(token, engagementId, byokKeyArn));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(`POST /api/admin/byok-key → upstream ${status}: ${(err as Error).message}`);
    // 400 is the "verification failed" case (malformed ARN, or the KMS
    // rewrap itself failed — grant missing/not propagated/wrong region) —
    // the upstream message is specific and safe to relay, unlike a bare
    // status code, since the caller is the admin who just submitted the ARN.
    const message =
      status === 400 && err instanceof ApiError
        ? err.message
        : (SET_BYOK_KEY_ERROR_MESSAGES[status] ?? 'upstream request failed');
    return NextResponse.json({ error: message }, { status });
  }
}
