/**
 * Return `url` only if it is a plain `http(s)` link, else `null`. Permalinks
 * come from `sources.url_permalink` (connector-provided) — treat them as
 * untrusted and never render a `javascript:` / `data:` href.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}
