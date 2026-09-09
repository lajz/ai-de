import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { factTypeSchema } from '@fde/core';
import { z } from 'zod';

/**
 * A hand-labelled extraction fixture: a short synthetic transcript chunk plus
 * what a correct extraction should contain. No real customer data — these are
 * written by hand.
 */
export const fixtureSchema = z.object({
  id: z.string().min(1),
  chunk: z.string().min(1),
  expected: z.object({
    /** how many facts of each type the chunk supports */
    factsByType: z.record(factTypeSchema, z.number().int().nonnegative()),
    /** phrases that must appear (case-insensitive) in some `evidence.quote` */
    keyPhrases: z.array(z.string().min(1)),
  }),
});
export type Fixture = z.infer<typeof fixtureSchema>;

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function loadFixtures(dir = FIXTURES_DIR): Fixture[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => fixtureSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}
