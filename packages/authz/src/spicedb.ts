import { v1 } from '@authzed/authzed-node';

import { AuthzClient } from './client.js';
import type {
  CheckRequest,
  Consistency,
  LookupResourcesRequest,
  RelationshipFilter,
  RelationshipUpdate,
  SubjectRef,
} from './types.js';

export interface SpiceDbConfig {
  /** host:port, e.g. `grpc.authzed.com:443` or `localhost:50051` */
  endpoint: string;
  /** the preshared key / Authzed token */
  token: string;
  /** plaintext gRPC (local `spicedb serve --grpc-no-tls`). TLS otherwise. */
  insecure?: boolean;
}

const OP: Record<RelationshipUpdate['operation'], v1.RelationshipUpdate_Operation> = {
  CREATE: v1.RelationshipUpdate_Operation.CREATE,
  TOUCH: v1.RelationshipUpdate_Operation.TOUCH,
  DELETE: v1.RelationshipUpdate_Operation.DELETE,
};

/**
 * `AuthzClient` over SpiceDB's v1 gRPC API (`@authzed/authzed-node`).
 *
 * Consistency policy:
 * - `check` / `lookupResources` default to `minimize_latency` — the fastest
 *   available snapshot. The read-path gate can tolerate a freshly-granted role
 *   landing a moment late; a stale *revoke* is backstopped by Postgres RLS.
 * - Pass `consistency: 'fully_consistent'` for a read that must reflect a write
 *   it just made (tests, an admin screen reading back a grant).
 * - `writeSchema` and `writeRelationships` are always transactional server-side;
 *   there is no consistency knob on a write.
 */
export class SpiceDbAuthzClient extends AuthzClient {
  private readonly client: v1.ZedClientInterface;

  constructor(config: SpiceDbConfig) {
    super();
    const security = config.insecure
      ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED
      : v1.ClientSecurity.SECURE;
    this.client = v1.NewClient(config.token, config.endpoint, security);
  }

  async check(req: CheckRequest): Promise<boolean> {
    const res = await this.client.promises.checkPermission(
      v1.CheckPermissionRequest.create({
        resource: objectRef(req.resource.type, req.resource.id),
        permission: req.permission,
        subject: subjectRef(req.subject),
        consistency: consistency(req.consistency),
      }),
    );
    return res.permissionship === v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;
  }

  async writeRelationships(updates: RelationshipUpdate[]): Promise<void> {
    if (updates.length === 0) return;
    await this.client.promises.writeRelationships(
      v1.WriteRelationshipsRequest.create({
        updates: updates.map((u) =>
          v1.RelationshipUpdate.create({
            operation: OP[u.operation],
            relationship: v1.Relationship.create({
              resource: objectRef(u.resource.type, u.resource.id),
              relation: u.relation,
              subject: subjectRef(u.subject),
            }),
          }),
        ),
      }),
    );
  }

  async deleteRelationships(filter: RelationshipFilter): Promise<void> {
    await this.client.promises.deleteRelationships(
      v1.DeleteRelationshipsRequest.create({
        relationshipFilter: v1.RelationshipFilter.create({
          resourceType: filter.resourceType,
          optionalResourceId: filter.resourceId ?? '',
          optionalRelation: filter.relation ?? '',
          optionalSubjectFilter: filter.subject
            ? v1.SubjectFilter.create({
                subjectType: filter.subject.type,
                optionalSubjectId: filter.subject.id ?? '',
                optionalRelation: filter.subject.relation
                  ? v1.SubjectFilter_RelationFilter.create({ relation: filter.subject.relation })
                  : undefined,
              })
            : undefined,
        }),
      }),
    );
  }

  async lookupResources(req: LookupResourcesRequest): Promise<string[]> {
    // The promise client buffers the server stream into an array.
    const responses = await this.client.promises.lookupResources(
      v1.LookupResourcesRequest.create({
        resourceObjectType: req.resourceType,
        permission: req.permission,
        subject: subjectRef(req.subject),
        consistency: consistency(req.consistency),
      }),
    );
    return responses
      .filter((r) => r.permissionship === v1.LookupPermissionship.HAS_PERMISSION)
      .map((r) => r.resourceObjectId);
  }

  async writeSchema(schema: string): Promise<void> {
    await this.client.promises.writeSchema(v1.WriteSchemaRequest.create({ schema }));
  }

  /** Close the underlying gRPC channel. */
  close(): void {
    this.client.close();
  }
}

function objectRef(objectType: string, objectId: string): v1.ObjectReference {
  return v1.ObjectReference.create({ objectType, objectId });
}

function subjectRef(subject: SubjectRef): v1.SubjectReference {
  return v1.SubjectReference.create({
    object: objectRef(subject.type, subject.id),
    optionalRelation: subject.relation ?? '',
  });
}

function consistency(c: Consistency = 'minimize_latency'): v1.Consistency {
  return v1.Consistency.create(
    c === 'fully_consistent'
      ? { requirement: { oneofKind: 'fullyConsistent', fullyConsistent: true } }
      : { requirement: { oneofKind: 'minimizeLatency', minimizeLatency: true } },
  );
}
