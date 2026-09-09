/**
 * Response shapes served by `@fde/api` (see `apps/api/openapi.json`). Hand-kept
 * to the handful of fields this read-only view renders — a generated client is a
 * later refinement.
 */
export interface Engagement {
  id: string;
  endCustomerName: string;
  regionPin: string;
  retentionPolicy: string;
  status: string;
  createdAt: string;
}

export interface EvidenceCitation {
  sourceId: string;
  permalink: string | null;
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: string;
}

export interface Fact {
  id: string;
  type: string;
  summary: string;
  body: string | null;
  status: string;
  confidence: number | null;
  occurredAt: string | null;
  createdAt: string;
  citations: EvidenceCitation[];
}

export interface QaCitation {
  sourceId: string;
  permalink: string | null;
  quote: string;
}

export interface QaResult {
  answer: string;
  citations: QaCitation[];
}
