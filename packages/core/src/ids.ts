import { z } from 'zod';

import type { Brand } from './branded.js';

export const zUuid = z.string().uuid();

export type TenantId = Brand<string, 'TenantId'>;
export type UserId = Brand<string, 'UserId'>;
export type EngagementId = Brand<string, 'EngagementId'>;
export type SourceId = Brand<string, 'SourceId'>;
export type EntityId = Brand<string, 'EntityId'>;
export type FactId = Brand<string, 'FactId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type RelationshipId = Brand<string, 'RelationshipId'>;
export type AclSnapshotId = Brand<string, 'AclSnapshotId'>;
export type ExtractionRunId = Brand<string, 'ExtractionRunId'>;
export type EmbeddingId = Brand<string, 'EmbeddingId'>;
export type IdentityId = Brand<string, 'IdentityId'>;
export type AccessLogId = Brand<string, 'AccessLogId'>;
