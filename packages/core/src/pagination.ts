/**
 * Generic keyset-pagination helpers, newest-first over `(created_at, id)`.
 * Originally lived in `@fde/audit` (the access-log listing), which still
 * re-exports these for backward compatibility — see `@fde/audit`'s
 * `cursor.ts`. Hoisted here so `@fde/db`'s facts/entities listings can reuse
 * the exact same cursor shape without a second copy.
 */
export interface KeysetCursor {
  createdAt: Date;
  id: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Clamps a requested page size to `(0, MAX_LIMIT]`, defaulting to `DEFAULT_LIMIT`. */
export function resolveLimit(limit?: number): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) return 1;
  return Math.min(limit, MAX_LIMIT);
}

export function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(
    JSON.stringify({ createdAt: cursor.createdAt.toISOString(), id: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Throws on a malformed cursor — treat as a bad request, not a silent reset to page 1. */
export function decodeCursor(cursor: string): KeysetCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { createdAt: unknown }).createdAt !== 'string' ||
      typeof (parsed as { id: unknown }).id !== 'string'
    ) {
      throw new Error('shape mismatch');
    }
    const createdAt = new Date((parsed as { createdAt: string }).createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error('invalid date');
    return { createdAt, id: (parsed as { id: string }).id };
  } catch {
    throw new Error('malformed pagination cursor');
  }
}
