import { log } from '@temporalio/activity';

export interface PingActivityInput {
  nonce: string;
}

export interface PingActivityResult {
  nonce: string;
  at: string;
}

/** Trivial activity proving the worker loop: no ids to resolve, no 🔒 data. */
export async function pingActivity(input: PingActivityInput): Promise<PingActivityResult> {
  // Not the nonce itself — it's opaque by contract, but nothing here needs it
  // to actually be non-sensitive to prove the loop works.
  log.info('ping activity invoked');
  return { nonce: input.nonce, at: new Date().toISOString() };
}
