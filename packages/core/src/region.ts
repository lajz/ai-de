import { z } from 'zod';

export const REGIONS = ['us', 'eu'] as const;
export const regionSchema = z.enum(REGIONS);
export type Region = (typeof REGIONS)[number];
