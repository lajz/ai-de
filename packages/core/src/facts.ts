import { z } from 'zod';

export const FACT_TYPES = [
  'decision',
  'commitment',
  'risk',
  'question',
  'action_item',
  'status_change',
] as const;
export const factTypeSchema = z.enum(FACT_TYPES);
export type FactType = (typeof FACT_TYPES)[number];

export const FACT_STATUSES = ['open', 'resolved', 'superseded', 'retracted'] as const;
export const factStatusSchema = z.enum(FACT_STATUSES);
export type FactStatus = (typeof FACT_STATUSES)[number];

export const EVIDENCE_RELATIONS = ['supports', 'contradicts'] as const;
export const evidenceRelationSchema = z.enum(EVIDENCE_RELATIONS);
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];

/** `[start, end)` character offsets into a source body that a quote came from. */
export const charSpanSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .refine((s) => s.end > s.start, { message: 'charSpan end must be greater than start' });
export type CharSpan = z.infer<typeof charSpanSchema>;
