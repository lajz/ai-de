import type {
  CustomEntityMapping,
  CustomIntegrationMapping,
  CustomRelationshipMapping,
} from '../../lib/types';

/** Editable, all-strings shape of a mapping — what the form binds to. */
export interface MappingDraft {
  artifact: {
    externalIdPath: string;
    kind: CustomIntegrationMapping['artifact']['kind'];
    occurredAtPath: string;
    urlPermalinkPath: string;
  };
  entities: {
    key: string;
    type: CustomEntityMapping['type'];
    externalIdPath: string;
    displayNamePath: string;
    bodyPath: string;
    attributes: { name: string; path: string }[];
  }[];
  relationships: CustomRelationshipMapping[];
}

export function emptyDraft(): MappingDraft {
  return {
    artifact: { externalIdPath: '', kind: 'issue', occurredAtPath: '', urlPermalinkPath: '' },
    entities: [
      {
        key: 'item',
        type: 'work_item',
        externalIdPath: '',
        displayNamePath: '',
        bodyPath: '',
        attributes: [],
      },
    ],
    relationships: [],
  };
}

export function draftFromMapping(m: CustomIntegrationMapping): MappingDraft {
  return {
    artifact: {
      externalIdPath: m.artifact.externalIdPath,
      kind: m.artifact.kind,
      occurredAtPath: m.artifact.occurredAtPath,
      urlPermalinkPath: m.artifact.urlPermalinkPath ?? '',
    },
    entities: m.entities.map((e) => ({
      key: e.key,
      type: e.type,
      externalIdPath: e.externalIdPath,
      displayNamePath: e.displayNamePath,
      bodyPath: e.bodyPath ?? '',
      attributes: Object.entries(e.attributes).map(([name, path]) => ({ name, path })),
    })),
    relationships: m.relationships.map((r) => ({ ...r })),
  };
}

/** Blank optional paths are omitted; blank attribute rows are dropped. The API does the real validation. */
export function mappingFromDraft(d: MappingDraft): CustomIntegrationMapping {
  return {
    artifact: {
      externalIdPath: d.artifact.externalIdPath.trim(),
      kind: d.artifact.kind,
      occurredAtPath: d.artifact.occurredAtPath.trim(),
      ...(d.artifact.urlPermalinkPath.trim()
        ? { urlPermalinkPath: d.artifact.urlPermalinkPath.trim() }
        : {}),
    },
    entities: d.entities.map((e) => ({
      key: e.key.trim(),
      type: e.type,
      externalIdPath: e.externalIdPath.trim(),
      displayNamePath: e.displayNamePath.trim(),
      ...(e.bodyPath.trim() ? { bodyPath: e.bodyPath.trim() } : {}),
      attributes: Object.fromEntries(
        e.attributes
          .filter((a) => a.name.trim() && a.path.trim())
          .map((a) => [a.name.trim(), a.path.trim()]),
      ),
    })),
    relationships: d.relationships.filter((r) => r.from && r.to),
  };
}
