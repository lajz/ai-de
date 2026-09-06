import type { Ciphertext, EncryptedColumnSpec } from '@fde/core';

import type { EngagementCipher } from './engagement-cipher.js';

/**
 * `T` with the named properties retyped as `Ciphertext`. A `null` / `undefined`
 * value passes through `encryptRow` untouched, so that part of the original type
 * is preserved (`facts.body?: string` becomes `facts.body?: Ciphertext`).
 */
export type WithCiphertext<T, P extends string> = Omit<T, P> & {
  [K in P & keyof T]: Ciphertext | Extract<T[K], null | undefined>;
};

/**
 * Returns a copy of `row` with the properties named in `specs` encrypted to
 * `Ciphertext`. Null/undefined pass through untouched. Pass the table's
 * `CRYPTO_COLUMNS` entry as `specs` so the prop names survive as literals and
 * the return type reflects which fields became `Ciphertext`.
 */
export async function encryptRow<
  T extends Record<string, unknown>,
  const S extends readonly EncryptedColumnSpec[],
>(cipher: EngagementCipher, specs: S, row: T): Promise<WithCiphertext<T, S[number]['prop']>> {
  const out: Record<string, unknown> = { ...row };
  for (const s of specs) {
    const v = row[s.prop];
    if (v == null) continue;
    out[s.prop] =
      s.codec === 'json'
        ? await cipher.encryptJson(s.path, v)
        : await cipher.encryptString(s.path, v as string);
  }
  return out as unknown as WithCiphertext<T, S[number]['prop']>;
}

/**
 * Inverse of `encryptRow`: takes a row whose `specs` properties are `Ciphertext`
 * and returns it with those properties decrypted. `T` is the plaintext row shape
 * the caller expects back; a `json`-codec column comes back as its parsed value.
 * Null/undefined pass through untouched.
 */
export async function decryptRow<T extends Record<string, unknown>>(
  cipher: EngagementCipher,
  specs: readonly EncryptedColumnSpec[],
  row: Record<string, unknown>,
): Promise<T> {
  const out: Record<string, unknown> = { ...row };
  for (const s of specs) {
    const v = row[s.prop];
    if (v == null) continue;
    out[s.prop] =
      s.codec === 'json'
        ? await cipher.decryptJson(s.path, v as Ciphertext)
        : await cipher.decryptString(s.path, v as Ciphertext);
  }
  return out as T;
}
