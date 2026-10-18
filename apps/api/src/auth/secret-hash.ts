import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** sha256 of a raw secret, as a Buffer. */
function hashSecret(raw: string): Buffer {
  return createHash('sha256').update(raw).digest();
}

/** sha256(raw), hex — the only form of a secret that is ever stored. */
export function hashSecretHex(raw: string): string {
  return hashSecret(raw).toString('hex');
}

/** A freshly minted secret. `raw` is shown to the issuer exactly once — only `hashHex`/`prefix` are stored. */
export interface GeneratedSecret {
  raw: string;
  /** leading `prefixLen` chars of `raw` — a non-secret fingerprint / lookup bucket */
  prefix: string;
  hashHex: string;
}

/** `randomBytes(32)` of entropy behind a greppable `rawPrefix`. Never logged. */
export function generateSecret(opts: { rawPrefix: string; prefixLen: number }): GeneratedSecret {
  const raw = `${opts.rawPrefix}${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, opts.prefixLen), hashHex: hashSecretHex(raw) };
}

/**
 * Constant-time compare of `raw` against a stored hex sha256. Never throws:
 * a malformed or wrong-length stored hash simply doesn't match
 * (`timingSafeEqual` itself throws on a length mismatch).
 */
export function secretMatches(raw: string, storedHashHex: string): boolean {
  const stored = Buffer.from(storedHashHex, 'hex');
  const target = hashSecret(raw);
  if (stored.length !== target.length) return false;
  return timingSafeEqual(stored, target);
}
