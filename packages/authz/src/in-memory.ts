import { AuthzClient } from './client.js';
import { AuthzError } from './errors.js';
import type {
  CheckRequest,
  LookupResourcesRequest,
  RelationshipFilter,
  RelationshipUpdate,
  SubjectRef,
} from './types.js';

interface Tuple {
  resourceType: string;
  resourceId: string;
  relation: string;
  subjectType: string;
  subjectId: string;
  subjectRelation?: string;
}

type Rule = { rel: string } | { arrow: string; then: string };

/**
 * The permission-resolution rules of `AUTHZ_SCHEMA`, encoded directly rather
 * than parsed from the `.zed` text. Kept deliberately small — it covers exactly
 * the platform-role schema. `schema.test.ts` guards that the two stay aligned.
 * When M5 adds `source_acl->access` to `engagement.view`, add the rule here too.
 */
const RULES: Record<string, Record<string, Rule[]>> = {
  tenant: {
    administer: [{ rel: 'admin' }],
    belong: [{ rel: 'admin' }, { rel: 'member' }],
  },
  engagement: {
    view: [
      { rel: 'viewer' },
      { rel: 'member' },
      { rel: 'admin' },
      { arrow: 'parent_tenant', then: 'administer' },
    ],
    contribute: [{ rel: 'member' }, { rel: 'admin' }],
    administer: [{ rel: 'admin' }],
  },
};

/**
 * Dependency-free `AuthzClient` over a list of relationship tuples. Resolves the
 * union-with-one-arrow schema with a small recursive expander (with cycle
 * guarding, so a future self-referential relation can't hang it). Backs every
 * unit test and local dev; `createAuthzClientFromEnv` refuses to hand one back
 * under `NODE_ENV=production`.
 *
 * `consistency` is ignored — the store is a single in-process Map, so every read
 * is already fully consistent.
 */
export class InMemoryAuthzClient extends AuthzClient {
  private tuples: Tuple[] = [];
  private schema?: string;

  // These are `async` so a synchronous `throw` (a duplicate CREATE) surfaces as
  // a rejected promise, matching the `AuthzClient` contract callers `await`.

  async check(req: CheckRequest): Promise<boolean> {
    return this.resolve(req.resource.type, req.resource.id, req.permission, req.subject, new Set());
  }

  async writeRelationships(updates: RelationshipUpdate[]): Promise<void> {
    for (const u of updates) {
      const t: Tuple = {
        resourceType: u.resource.type,
        resourceId: u.resource.id,
        relation: u.relation,
        subjectType: u.subject.type,
        subjectId: u.subject.id,
        subjectRelation: u.subject.relation,
      };
      const existing = this.tuples.findIndex((x) => sameTuple(x, t));
      if (u.operation === 'DELETE') {
        if (existing !== -1) this.tuples.splice(existing, 1);
      } else if (existing === -1) {
        this.tuples.push(t);
      } else if (u.operation === 'CREATE') {
        throw new AuthzError(
          `relationship already exists: ${t.resourceType}:${t.resourceId}#${t.relation}@${t.subjectType}:${t.subjectId}`,
        );
      }
      // TOUCH on an existing tuple: no-op.
    }
  }

  async deleteRelationships(filter: RelationshipFilter): Promise<void> {
    this.tuples = this.tuples.filter((t) => !matchesFilter(t, filter));
  }

  async lookupResources(req: LookupResourcesRequest): Promise<string[]> {
    const candidates = new Set(
      this.tuples.filter((t) => t.resourceType === req.resourceType).map((t) => t.resourceId),
    );
    const out: string[] = [];
    for (const id of candidates) {
      if (this.resolve(req.resourceType, id, req.permission, req.subject, new Set())) out.push(id);
    }
    return out.sort();
  }

  async writeSchema(schema: string): Promise<void> {
    this.schema = schema;
  }

  /** Test helper — the schema last passed to `writeSchema`. */
  currentSchema(): string | undefined {
    return this.schema;
  }

  private resolve(
    resourceType: string,
    resourceId: string,
    name: string,
    subject: SubjectRef,
    seen: Set<string>,
  ): boolean {
    const key = `${resourceType}:${resourceId}#${name}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const rules = RULES[resourceType]?.[name];
    if (!rules) {
      // `name` is a plain relation, not a permission.
      return this.relationHolds(resourceType, resourceId, name, subject, seen);
    }
    for (const rule of rules) {
      if ('rel' in rule) {
        if (this.relationHolds(resourceType, resourceId, rule.rel, subject, seen)) return true;
      } else {
        for (const t of this.tuples) {
          if (
            t.resourceType === resourceType &&
            t.resourceId === resourceId &&
            t.relation === rule.arrow &&
            this.resolve(t.subjectType, t.subjectId, rule.then, subject, seen)
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private relationHolds(
    resourceType: string,
    resourceId: string,
    relation: string,
    subject: SubjectRef,
    seen: Set<string>,
  ): boolean {
    for (const t of this.tuples) {
      if (
        t.resourceType !== resourceType ||
        t.resourceId !== resourceId ||
        t.relation !== relation
      ) {
        continue;
      }
      if (!t.subjectRelation) {
        if (t.subjectType === subject.type && t.subjectId === subject.id) return true;
      } else if (this.resolve(t.subjectType, t.subjectId, t.subjectRelation, subject, seen)) {
        return true;
      }
    }
    return false;
  }
}

function sameTuple(a: Tuple, b: Tuple): boolean {
  return (
    a.resourceType === b.resourceType &&
    a.resourceId === b.resourceId &&
    a.relation === b.relation &&
    a.subjectType === b.subjectType &&
    a.subjectId === b.subjectId &&
    (a.subjectRelation ?? '') === (b.subjectRelation ?? '')
  );
}

function matchesFilter(t: Tuple, f: RelationshipFilter): boolean {
  if (t.resourceType !== f.resourceType) return false;
  if (f.resourceId !== undefined && t.resourceId !== f.resourceId) return false;
  if (f.relation !== undefined && t.relation !== f.relation) return false;
  if (f.subject) {
    if (t.subjectType !== f.subject.type) return false;
    if (f.subject.id !== undefined && t.subjectId !== f.subject.id) return false;
    if (f.subject.relation !== undefined && (t.subjectRelation ?? '') !== f.subject.relation) {
      return false;
    }
  }
  return true;
}
