import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAuthzClientFromEnv } from './env.js';
import { InMemoryAuthzClient } from './in-memory.js';
import { InMemoryInProductionError } from './errors.js';
import { SpiceDbAuthzClient } from './spicedb.js';

afterEach(() => vi.restoreAllMocks());

describe('createAuthzClientFromEnv', () => {
  it('returns SpiceDbAuthzClient when endpoint + token are set', () => {
    const client = createAuthzClientFromEnv({
      NODE_ENV: 'test',
      SPICEDB_ENDPOINT: 'localhost:50051',
      SPICEDB_TOKEN: 'dev',
      SPICEDB_INSECURE: 'true',
    });
    expect(client).toBeInstanceOf(SpiceDbAuthzClient);
  });

  it('falls back to InMemoryAuthzClient with a stderr warning when unset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const client = createAuthzClientFromEnv({ NODE_ENV: 'test' });
    expect(client).toBeInstanceOf(InMemoryAuthzClient);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('refuses the in-memory fallback under NODE_ENV=production', () => {
    expect(() => createAuthzClientFromEnv({ NODE_ENV: 'production' })).toThrow(
      InMemoryInProductionError,
    );
  });
});
