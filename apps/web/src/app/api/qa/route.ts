import { NextResponse } from 'next/server';

import { ApiError, askQuestion } from '../../../lib/api';
import { getSessionToken } from '../../../lib/session';

/**
 * Same-origin proxy for the Q&A call. Keeps the session token server-side: the
 * browser posts `{ engagementId, question }` here, this handler forwards it to
 * `@fde/api` with the caller's bearer token and relays the answer.
 */
export async function POST(req: Request): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  const { engagementId, question } = (body ?? {}) as {
    engagementId?: unknown;
    question?: unknown;
  };
  if (typeof engagementId !== 'string' || engagementId === '') {
    return NextResponse.json({ error: 'engagementId is required' }, { status: 400 });
  }
  if (typeof question !== 'string' || question.trim() === '') {
    return NextResponse.json({ error: 'question is required' }, { status: 400 });
  }

  const token = await getSessionToken();
  try {
    return NextResponse.json(await askQuestion(token, engagementId, question));
  } catch (err) {
    const status = err instanceof ApiError ? err.status : 502;
    // Server-side only, status + message (never a body) — the client gets a
    // generic message so upstream error detail is not relayed to the browser.
    console.error(`POST /api/qa → upstream ${status}: ${(err as Error).message}`);
    return NextResponse.json({ error: 'upstream request failed' }, { status });
  }
}
