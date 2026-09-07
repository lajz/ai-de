import { PromptNotFoundError } from '../errors.js';
import { EXTRACTION_PROMPT } from './extraction.js';

/** A versioned system prompt. `version` is opaque but must sort lexically by recency (date or `vN`). */
export interface PromptDefinition {
  name: string;
  version: string;
  system: string;
}

export interface ResolvedPrompt {
  system: string;
  version: string;
}

const REGISTRY = new Map<string, Map<string, PromptDefinition>>();

/** Register a prompt version. Idempotent for an identical definition; throws on a conflicting redefinition. */
export function registerPrompt(def: PromptDefinition): void {
  let versions = REGISTRY.get(def.name);
  if (!versions) {
    versions = new Map();
    REGISTRY.set(def.name, versions);
  }
  const existing = versions.get(def.version);
  if (existing && existing.system !== def.system) {
    throw new Error(
      `prompt "${def.name}" v${def.version} is already registered with different text`,
    );
  }
  versions.set(def.version, def);
}

/** All registered versions of a prompt, most-recent (highest-sorting) first. */
export function listPromptVersions(name: string): string[] {
  const versions = REGISTRY.get(name);
  if (!versions) return [];
  return [...versions.keys()].sort().reverse();
}

/** Resolve a prompt. Without `version`, returns the highest-sorting (latest) version. */
export function getPrompt(name: string, version?: string): ResolvedPrompt {
  const versions = REGISTRY.get(name);
  if (!versions || versions.size === 0) throw new PromptNotFoundError(name);

  if (version) {
    const def = versions.get(version);
    if (!def) throw new PromptNotFoundError(name, version);
    return { system: def.system, version: def.version };
  }

  const latest = [...versions.keys()].sort().at(-1)!;
  const def = versions.get(latest)!;
  return { system: def.system, version: def.version };
}

registerPrompt(EXTRACTION_PROMPT);
