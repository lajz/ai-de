import { describe, expect, it } from 'vitest';

import { normalizeDomain, normalizeEmail, normalizeName } from './normalize.js';

describe('normalizeEmail', () => {
  it('lower-cases and trims', () => {
    expect(normalizeEmail('  Jane.Smith@Acme.COM ')).toBe('jane.smith@acme.com');
  });
  it('strips +tag sub-addressing from the local part only', () => {
    expect(normalizeEmail('jane+recruiting@acme.com')).toBe('jane@acme.com');
    expect(normalizeEmail('jane@acme.com')).toBe('jane@acme.com');
  });
  it('normalizes the domain part', () => {
    expect(normalizeEmail('jane@WWW.Acme.com.')).toBe('jane@acme.com');
  });
  it('folds unicode width', () => {
    expect(normalizeEmail('ｊａｎｅ@acme.com')).toBe('jane@acme.com');
  });
  it('returns a best-effort key for a non-email', () => {
    expect(normalizeEmail(' NotAnEmail ')).toBe('notanemail');
    expect(normalizeEmail('trailing@')).toBe('trailing@');
  });
});

describe('normalizeDomain', () => {
  it('drops scheme, www, path and trailing dot', () => {
    expect(normalizeDomain('HTTPS://www.Acme.com/careers?x=1')).toBe('acme.com');
    expect(normalizeDomain('acme.com.')).toBe('acme.com');
  });
});

describe('normalizeName', () => {
  it('folds case, punctuation and whitespace', () => {
    expect(normalizeName('  Jane   T. Smith-Jones ')).toBe('jane t smith jones');
  });
  it('strips diacritics for comparison', () => {
    expect(normalizeName('José Núñez')).toBe('jose nunez');
  });
  it('handles CJK without throwing', () => {
    expect(normalizeName('田中 太郎')).toBe('田中 太郎');
  });
});
