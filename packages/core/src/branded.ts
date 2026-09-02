/** Nominal typing helper. `Brand<string, 'TenantId'>` is not assignable from a bare string. */
export type Brand<T, B extends string> = T & { readonly __brand: B };

/** Lowercase-hex SHA-256 digest. */
export type Sha256Hex = Brand<string, 'Sha256Hex'>;

/**
 * An application-layer encryption envelope (per-engagement DEK), produced by
 * `@fde/crypto`. Opaque everywhere except the crypto + repository-mapper layers —
 * the database and the ORM only ever see this, never plaintext.
 */
export type Ciphertext = Brand<Uint8Array, 'Ciphertext'>;
