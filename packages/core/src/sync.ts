import type { RawArtifact } from './raw-artifact.js';

/** Opaque, connector-defined incremental-sync position. Persisted between runs. */
export type SyncCursor = string;

/**
 * A connector sync is a stream of artifacts interleaved with checkpoints. The
 * runner persists the latest checkpoint, so a crashed backfill resumes from there
 * instead of restarting.
 */
export type SyncEmit =
  | { readonly type: 'artifact'; readonly artifact: RawArtifact }
  | { readonly type: 'checkpoint'; readonly cursor: SyncCursor };

export const artifactEmit = (artifact: RawArtifact): SyncEmit => ({ type: 'artifact', artifact });
export const checkpointEmit = (cursor: SyncCursor): SyncEmit => ({ type: 'checkpoint', cursor });
