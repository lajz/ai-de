/** Low-level vocabulary shared by every `AuthzClient` implementation. */

/** A subject in a check / relationship — usually a concrete `user`, occasionally a subject set. */
export interface SubjectRef {
  type: string;
  id: string;
  /** sub-relation on the subject, e.g. `group:eng#member` — rare; unused by the platform-role schema */
  relation?: string;
}

/** The object a permission is checked on, or the resource half of a relationship. */
export interface ResourceRef {
  type: string;
  id: string;
}

/**
 * How fresh the data behind a read must be.
 *
 * - `minimize_latency` (default for checks) — SpiceDB picks the fastest cached
 *   snapshot. Fine for a read-path gate: a just-granted role showing up a few
 *   hundred ms late is acceptable, a revoked one lingering briefly is covered by
 *   the RLS layer underneath.
 * - `fully_consistent` — the most recent snapshot, no caching. Slower. Use right
 *   after a write when the result must reflect it (tests; an admin UI that reads
 *   back what it just granted).
 */
export type Consistency = 'minimize_latency' | 'fully_consistent';

export type RelationshipOp = 'CREATE' | 'TOUCH' | 'DELETE';

/**
 * One relationship mutation. `CREATE` errors if the tuple already exists;
 * `TOUCH` upserts; `DELETE` is a no-op if it's already gone.
 */
export interface RelationshipUpdate {
  operation: RelationshipOp;
  resource: ResourceRef;
  relation: string;
  subject: SubjectRef;
}

/**
 * Matches a set of relationships for bulk deletion. Every field narrows;
 * `{ resourceType: 'engagement', resourceId: x }` deletes every relation on
 * engagement `x`. `resourceType` is always required.
 */
export interface RelationshipFilter {
  resourceType: string;
  resourceId?: string;
  relation?: string;
  subject?: {
    type: string;
    id?: string;
    relation?: string;
  };
}

export interface CheckRequest {
  subject: SubjectRef;
  permission: string;
  resource: ResourceRef;
  consistency?: Consistency;
}

export interface LookupResourcesRequest {
  subject: SubjectRef;
  permission: string;
  resourceType: string;
  consistency?: Consistency;
}
