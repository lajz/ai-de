const UNITS: [limit: number, div: number, name: Intl.RelativeTimeFormatUnit][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [2592000, 86400, 'day'],
  [31536000, 2592000, 'month'],
  [Infinity, 31536000, 'year'],
];

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** Compact relative time ("3 hours ago") for an ISO timestamp, or `null` for a missing one. */
export function relativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const deltaSec = (then - now) / 1000;
  const abs = Math.abs(deltaSec);
  for (const [limit, div, name] of UNITS) {
    if (abs < limit) return rtf.format(Math.round(deltaSec / div), name);
  }
  return null;
}
