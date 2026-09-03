/** How an encrypted column's plaintext round-trips through `@fde/crypto`. */
export type EncryptedColumnCodec = 'string' | 'json';

/**
 * Describes one application-layer-encrypted column: where it sits on a row, the
 * encryption-context path that binds its ciphertext to that column, and how the
 * plaintext is serialized.
 */
export interface EncryptedColumnSpec {
  /** the row property name */
  readonly prop: string;
  /** encryption-context path, e.g. `"facts.body"` — part of the AAD */
  readonly path: string;
  readonly codec: EncryptedColumnCodec;
}
