import type { DemoDefinition } from '../lib/types.js';
import { lucerneHealth } from './lucerne-health/index.js';

/**
 * The demo registry. Adding a future demo means: add one `demos/<slug>/`
 * folder (its own `fixtures.ts` + an `index.ts` exporting a `DemoDefinition`),
 * then add one line here — nothing else in `seed-demo.ts` or `lib/` changes.
 */
export const DEMOS: Readonly<Record<string, DemoDefinition>> = {
  'lucerne-health': lucerneHealth,
};
