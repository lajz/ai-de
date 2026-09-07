import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const activitiesDir = dirname(fileURLToPath(import.meta.url));

/**
 * The crypto-boundary convention (see `engagement-context.ts`): activities
 * take a cipher as an explicit argument, never off `AsyncLocalStorage`.
 * `withEngagementActivity` itself touches `tryGetCryptoContext` once, in a
 * documented, safe way — everything else under `activities/` must not.
 */
describe('crypto-boundary convention', () => {
  const files = readdirSync(activitiesDir).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'engagement-context.ts',
  );

  it.each(files)('%s does not reach for AsyncLocalStorage or getCipher', (file) => {
    const src = readFileSync(join(activitiesDir, file), 'utf8');
    expect(src).not.toMatch(/AsyncLocalStorage/);
    expect(src).not.toMatch(/\bgetCipher\b/);
  });

  it('found at least one activity file to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
});
