/**
 * Semantic color for a fact's `type` (decision/commitment/risk/…), shared by
 * the fact list, provenance chain and entity graph so the same kind of claim
 * reads as the same color everywhere. Each type has a "line" tone (saturated,
 * used for text/borders/legend swatches) and a "wash" tone (a light fill safe
 * to sit under dark text, used for node/badge backgrounds). Falls back to a
 * stable hash for any type not in the known set, so new fact/entity types
 * never render unstyled.
 */
const KNOWN_FACT_LINE: Record<string, string> = {
  decision: '#2a5fb0',
  commitment: '#157f4b',
  risk: '#c4281c',
  action_item: '#b7791f',
};

const KNOWN_FACT_LINE_DARK: Record<string, string> = {
  decision: '#6e9be8',
  commitment: '#4cc487',
  risk: '#ea6a5c',
  action_item: '#e0ab4c',
};

const KNOWN_FACT_WASH: Record<string, string> = {
  decision: '#e8eefa',
  commitment: '#e7f5ee',
  risk: '#fbeae8',
  action_item: '#fbf1de',
};

const KNOWN_FACT_WASH_DARK: Record<string, string> = {
  decision: '#1c2a41',
  commitment: '#143226',
  risk: '#3a1a17',
  action_item: '#362a11',
};

function hashHue(type: string): number {
  let hash = 0;
  for (const ch of type) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

/** Saturated tone for text, left-borders and legend swatches. */
export function factTypeColor(type: string, dark = false): string {
  const known = dark ? KNOWN_FACT_LINE_DARK : KNOWN_FACT_LINE;
  if (known[type]) return known[type];
  const hue = hashHue(type);
  return dark ? `hsl(${hue} 65% 70%)` : `hsl(${hue} 55% 38%)`;
}

/** Light fill safe under dark text — used for graph-node backgrounds. */
export function factTypeWash(type: string, dark = false): string {
  const known = dark ? KNOWN_FACT_WASH_DARK : KNOWN_FACT_WASH;
  if (known[type]) return known[type];
  const hue = hashHue(type);
  return dark ? `hsl(${hue} 30% 20%)` : `hsl(${hue} 60% 92%)`;
}

/** Stable hash-based hue per entity type: a light fill for nodes/badges. */
export function entityTypeColor(type: string, dark = false): string {
  const hue = hashHue(type);
  return dark ? `hsl(${hue} 35% 24%)` : `hsl(${hue} 60% 88%)`;
}

/** The same hue as {@link entityTypeColor}, at legend-swatch saturation. */
export function entityTypeLine(type: string, dark = false): string {
  const hue = hashHue(type);
  return dark ? `hsl(${hue} 55% 65%)` : `hsl(${hue} 45% 45%)`;
}
