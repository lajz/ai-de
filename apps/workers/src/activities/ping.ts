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
  log.info('ping', { nonce: input.nonce });
  return { nonce: input.nonce, at: new Date().toISOString() };
}
