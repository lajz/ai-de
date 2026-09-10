import { NextResponse } from 'next/server';

import { ApiError, startConnectorSync } from '../../../../lib/api';
import { getSessionToken } from '../../../../lib/session';

const SYNC_ERROR_MESSAGES: Record<number, string> = {
  409: 'connector is not enabled or has no stored credential',
  503: 'sync engine (Temporal) is not configured for this deployment',
};

/**
 * Same-origin proxy for `POST /engagements/:id/connectors/:connectorId/sync`.
 * The 409 (not enabled / no credential) and 503 (Temporal unconfigured) statuses
 * are relayed with a human-readable message so the client can surface them.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, connectorId, mode } = (body ?? {}) as {
    engagementId?: unknown;
    connectorId?: unknown;
    mode?: unknown;
  };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof connectorId !== 'string' || connectorId === '') {
    return NextResponse.json({ error: 'connectorId is required' }, { status: 400 });
  }
  if (mode !== 'backfill' && mode !== 'incremental') {
    return NextResponse.json(
      { error: "mode must be 'backfill' or 'incremental'" },
      { status: 400 },
    );
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await startConnectorSync(token, engagementId, connectorId, mode));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    console.error(`POST /api/admin/sync → upstream ${status}: ${(err as Error).message}`);
    return NextResponse.json(
      { error: SYNC_ERROR_MESSAGES[status] ?? 'upstream request failed' },
      { status },
    );
  }
}
