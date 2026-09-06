import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { canCallModel, loadConfig } from './config.js';
import type { Config } from './types.js';

function fixtureRoot(fileContent?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'fde-review-'));
  if (fileContent !== undefined) writeFileSync(join(dir, '.fde-review.json'), fileContent);
  return dir;
}

const MODEL_ENV = [
  'REVIEW_API_KEY',
  'REVIEW_BASE_URL',
  'REVIEW_MODEL',
  'REVIEW_BASE',
  'REVIEW_MIN_SEVERITY',
  'REVIEW_BLOCKING_SEVERITY',
  'REVIEW_FAIL_ON',
  'GITHUB_ACTIONS',
];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(MODEL_ENV.map((k) => [k, process.env[k]]));
  for (const k of MODEL_ENV) delete process.env[k];
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('loadConfig precedence', () => {
  it('uses built-in defaults with no file and no env', () => {
    const cfg = loadConfig({}, fixtureRoot());
    expect(cfg.baseUrl).toBe('https://api.deepseek.com');
    expect(cfg.model).toBe('deepseek-v4-flash');
    expect(cfg.minSeverity).toBe('nit');
    expect(cfg.blockingSeverity).toBe('high');
    expect(cfg.failOn).toBeNull();
  });

  it('ignores a .fde-review.json that disables passes when GITHUB_ACTIONS=true', () => {
    const disabling = '{"passes":{"review":false,"security":false}}';
    expect(loadConfig({}, fixtureRoot(disabling)).passes).toEqual({
      review: false,
      security: false,
    });
    process.env.GITHUB_ACTIONS = 'true';
    expect(loadConfig({}, fixtureRoot(disabling)).passes).toEqual({ review: true, security: true });
  });

  it('reads blockingSeverity from env and file', () => {
    process.env.REVIEW_BLOCKING_SEVERITY = 'medium';
    expect(loadConfig({}, fixtureRoot()).blockingSeverity).toBe('medium');
    delete process.env.REVIEW_BLOCKING_SEVERITY;
    expect(loadConfig({}, fixtureRoot('{"blockingSeverity":"low"}')).blockingSeverity).toBe('low');
  });

  it('lets .fde-review.json override defaults', () => {
    const cfg = loadConfig({}, fixtureRoot('{"model":"deepseek-v4-pro","minSeverity":"medium"}'));
    expect(cfg.model).toBe('deepseek-v4-pro');
    expect(cfg.minSeverity).toBe('medium');
  });

  it('lets env override the file', () => {
    process.env.REVIEW_MODEL = 'from-env';
    const cfg = loadConfig({}, fixtureRoot('{"model":"from-file"}'));
    expect(cfg.model).toBe('from-env');
  });

  it('lets explicit overrides win over everything', () => {
    process.env.REVIEW_MODEL = 'from-env';
    const cfg = loadConfig({ model: 'from-arg' }, fixtureRoot('{"model":"from-file"}'));
    expect(cfg.model).toBe('from-arg');
  });

  it('ignores an invalid minSeverity', () => {
    const cfg = loadConfig({}, fixtureRoot('{"minSeverity":"bogus"}'));
    expect(cfg.minSeverity).toBe('nit');
  });
});

describe('canCallModel', () => {
  const base = (over: Partial<Config>): Config =>
    loadConfig({ ...over } as Partial<Config>, fixtureRoot());

  it('is false with no key against a remote endpoint', () => {
    expect(canCallModel(base({ apiKey: null, baseUrl: 'https://api.deepseek.com' }))).toBe(false);
  });

  it('is true with a key', () => {
    expect(canCallModel(base({ apiKey: 'sk-x' }))).toBe(true);
  });

  it('is true against localhost with no key (Ollama)', () => {
    expect(canCallModel(base({ apiKey: null, baseUrl: 'http://localhost:11434/v1' }))).toBe(true);
  });

  it('is true for the claude shim with no key', () => {
    expect(canCallModel(base({ apiKey: null, model: 'claude' }))).toBe(true);
  });
});
