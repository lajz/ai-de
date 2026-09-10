/**
 * Deterministic-key normalizers. Every identity key (email, SSO subject, org
 * domain) and every display name is run through these before it is compared or
 * stored, so `Jane@Acme.com `, `jane+recruiting@acme.com` and `jane@acme.com`
 * all collapse to one key.
 */

/**
 * Lower-case, trim, drop `+tag` sub-addressing from the local part, normalize the
 * domain (see `normalizeDomain`). A value that is not email-shaped is returned
 * trimmed + lower-cased so callers still get a stable key.
 */
export function normalizeEmail(raw: string): string {
  const trimmed = raw.normalize('NFKC').trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;
  const local = trimmed.slice(0, at).replace(/\+.*$/, '');
  return `${local}@${normalizeDomain(trimmed.slice(at + 1))}`;
}

/**
 * Lower-case, trim, NFKC-fold, strip a leading scheme / `www.` / any path, drop a
 * trailing dot. `HTTPS://WWW.Acme.com/foo` → `acme.com`.
 */
export function normalizeDomain(raw: string): string {
  return raw
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '');
}

/**
 * Fold a display name for fuzzy comparison: NFKD-decompose, drop combining marks
 * (`José` → `jose`), lower-case, replace every non-alphanumeric run with a single
 * space, trim. Not reversible — comparison only, never stored as the name.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
