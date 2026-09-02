import { customType } from 'drizzle-orm/pg-core';

import type { Ciphertext } from '@fde/core';

/**
 * Application-layer encrypted column, stored as `bytea`. The value is an
 * `@fde/crypto` `Ciphertext` (an envelope produced with the per-engagement DEK).
 *
 * This type is only the `Ciphertext ↔ bytea` transport. Encryption and
 * decryption are async (a KMS unwrap may be involved) and cannot run inside a
 * synchronous Drizzle codec, so they happen one layer up — in the repository
 * mapper, via `encryptRow` / `decryptRow` (`@fde/crypto`) keyed by the row's
 * engagement (see `CRYPTO_COLUMNS`). That mapper lands with `@fde/crypto` in the
 * next PR; until then nothing in this package writes a 🔒 column.
 */
export const encrypted = customType<{ data: Ciphertext; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Ciphertext): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Ciphertext {
    return new Uint8Array(value) as Ciphertext;
  },
});
