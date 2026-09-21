// `KeysetCursor` / `resolveLimit` / `encodeCursor` / `decodeCursor` live in
// `@fde/core` now (shared with `@fde/db`'s facts/entities listings);
// re-exported here so existing imports of these from `@fde/audit`'s
// `cursor.js` keep working unchanged.
export type { KeysetCursor as AccessLogCursor } from '@fde/core';
export { resolveLimit, encodeCursor, decodeCursor } from '@fde/core';
