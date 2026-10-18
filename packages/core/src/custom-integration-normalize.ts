import { z } from 'zod';

import type { CanonicalRecord } from './canonical.js';
import type {
  CustomArtifactMapping,
  CustomIntegrationMapping,
} from './custom-integration-mapping.js';
import type { ExternalRef } from './entities.js';
import type { RawArtifact } from './raw-artifact.js';

/** One thing in the mapping that did not resolve against a given payload. */
export interface CustomMappingIssue {
  /** where in the mapping, e.g. `entities[0].externalIdPath` */
  at: string;
  message: string;
}

export class CustomMappingValidationError extends Error {
  constructor(readonly issues: CustomMappingIssue[]) {
    super(`custom mapping failed: ${issues.map((i) => `${i.at}: ${i.message}`).join('; ')}`);
    this.name = 'CustomMappingValidationError';
  }
}

const TOKEN_RE = /([A-Za-z_$][A-Za-z0-9_$-]*)|\[(\d+)\]/g;

/**
 * Walks `path` (`a.b[0].c`) through `payload`. Returns `undefined` on any
 * missing key, out-of-range index, or non-object/array segment — never throws.
 * Only own properties are followed, so `__proto__`/`constructor` can't leak.
 */
export function resolveDotPath(payload: unknown, path: string): unknown {
  let cur: unknown = payload;
  for (const m of path.matchAll(TOKEN_RE)) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (m[1] !== undefined) {
      if (Array.isArray(cur) || !Object.hasOwn(cur, m[1])) return undefined;
      cur = (cur as Record<string, unknown>)[m[1]];
    } else {
      const idx = Number(m[2]);
      if (!Array.isArray(cur) || idx >= cur.length) return undefined;
      cur = cur[idx];
    }
  }
  return cur;
}

/** A non-blank string, or a finite number rendered as one. */
function asId(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() ? v : undefined;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

const isoSchema = z.string().datetime({ offset: true });

export interface NormalizeCustomResult {
  records: CanonicalRecord[];
  issues: CustomMappingIssue[];
}

/**
 * Pure: derive canonical records from `payload` per `mapping`. Non-strict
 * (default) returns whatever resolved plus the issues for what didn't — good
 * for dry-runs. `strict` throws `CustomMappingValidationError` on any issue so
 * a partially-wrong payload never lands a partial graph write. A relationship
 * is emitted only when both of its endpoints resolved for this payload.
 */
export function normalizeCustomArtifact(
  mapping: CustomIntegrationMapping,
  connectorId: string,
  payload: unknown,
  opts: { strict?: boolean } = {},
): NormalizeCustomResult {
  const issues: CustomMappingIssue[] = [];
  const records: CanonicalRecord[] = [];
  const refs = new Map<string, ExternalRef>();

  mapping.entities.forEach((e, i) => {
    const at = `entities[${i}]`;
    const externalId = asId(resolveDotPath(payload, e.externalIdPath));
    if (!externalId) {
      issues.push({ at: `${at}.externalIdPath`, message: `no id at "${e.externalIdPath}"` });
    }
    const displayName = asId(resolveDotPath(payload, e.displayNamePath));
    if (!displayName) {
      issues.push({
        at: `${at}.displayNamePath`,
        message: `no name at "${e.displayNamePath}"`,
      });
    }
    if (!externalId || !displayName) return;

    let body: string | undefined;
    if (e.bodyPath) {
      const b = resolveDotPath(payload, e.bodyPath);
      if (typeof b === 'string' && b.length > 0) body = b;
      else if (b !== undefined && b !== null) {
        issues.push({ at: `${at}.bodyPath`, message: `value at "${e.bodyPath}" is not a string` });
      }
    }

    const attributes: Record<string, unknown> = {};
    for (const [name, p] of Object.entries(e.attributes)) {
      const v = resolveDotPath(payload, p);
      if (v === undefined) {
        issues.push({ at: `${at}.attributes.${name}`, message: `nothing at "${p}"` });
      } else {
        attributes[name] = v;
      }
    }

    const ref: ExternalRef = { connector: connectorId, externalId };
    refs.set(e.key, ref);
    records.push({
      kind: 'entity',
      type: e.type,
      displayName,
      externalRefs: [ref],
      attributes,
      ...(body ? { body } : {}),
    });
  });

  mapping.relationships.forEach((r, i) => {
    const from = refs.get(r.from);
    const to = refs.get(r.to);
    if (!from || !to) {
      issues.push({
        at: `relationships[${i}]`,
        message: `endpoint "${!from ? r.from : r.to}" did not resolve for this payload`,
      });
      return;
    }
    records.push({ kind: 'relationship', from, predicate: r.predicate, to });
  });

  if (opts.strict && issues.length > 0) throw new CustomMappingValidationError(issues);
  return { records, issues };
}

/**
 * Builds the `RawArtifact` for a push: dedupe identity + timestamp come from
 * the artifact-level paths; the whole payload rides in `raw` so `normalize`
 * can pure-re-derive records later. The ACL is a placeholder — the runner
 * resolves the authoritative snapshot.
 */
export function buildCustomRawArtifact(
  mapping: CustomArtifactMapping,
  connectorId: string,
  payload: Record<string, unknown>,
): RawArtifact {
  const issues: CustomMappingIssue[] = [];
  const externalId = asId(resolveDotPath(payload, mapping.externalIdPath));
  if (!externalId) {
    issues.push({ at: 'artifact.externalIdPath', message: `no id at "${mapping.externalIdPath}"` });
  }
  const occurred = isoSchema.safeParse(resolveDotPath(payload, mapping.occurredAtPath));
  if (!occurred.success) {
    issues.push({
      at: 'artifact.occurredAtPath',
      message: `no ISO-8601 timestamp at "${mapping.occurredAtPath}"`,
    });
  }
  let urlPermalink: string | undefined;
  if (mapping.urlPermalinkPath) {
    const u = resolveDotPath(payload, mapping.urlPermalinkPath);
    if (u !== undefined && u !== null) {
      const parsed = z.string().url().safeParse(u);
      if (parsed.success) urlPermalink = parsed.data;
      else {
        issues.push({
          at: 'artifact.urlPermalinkPath',
          message: `value at "${mapping.urlPermalinkPath}" is not a URL`,
        });
      }
    }
  }
  if (issues.length > 0 || !externalId || !occurred.success) {
    throw new CustomMappingValidationError(issues);
  }
  return {
    connector: connectorId,
    externalId,
    kind: mapping.kind,
    ...(urlPermalink ? { urlPermalink } : {}),
    // normalize() accepts offset timestamps, but RawArtifact wants a canonical instant
    occurredAt: new Date(occurred.data).toISOString(),
    raw: payload,
    acl: { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: 86400 },
  };
}
