import { customType } from 'drizzle-orm/pg-core';

import type { Ciphertext } from '@fde/core';

/**
 * Application-layer encrypted column: an `@fde/crypto` `Ciphertext` (envelope
 * produced with the per-engagement DEK) stored as `bytea`. This type is only the
 * `Ciphertext ↔ bytea` transport — encryption/decryption is async (a KMS unwrap
 * may be involved) and therefore happens in the repository mapper via
 * `encryptRow` / `decryptRow` (`@fde/crypto`) + the `CRYPTO_COLUMNS` specs, not
 * here. The DB and the ORM never see plaintext.
 */
export const encrypted = customType<{ data: Ciphertext; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
  toDriver(value: Ciphertext): Buffer {
    return Buffer.from(value);
  },
  fromDriver(value: Buffer): Ciphertext {
    // symmetric with toDriver — copy out of the driver buffer into a plain
    // Uint8Array (`Ciphertext` is a branded Uint8Array)
    return new Uint8Array(value) as Ciphertext;
  },
});
