import { execFileSync } from 'node:child_process';

import type { Config, ReviewContext } from './types.js';

const GIT_MAX_BUFFER = 64 * 1024 * 1024;

/** Resolved once: every git call runs from the repo root, not the package cwd. */
const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

function git(args: string[]): string {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function refExists(ref: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the ref to diff against: the integration branch, not this branch's own
 * upstream (a topic branch tracking `origin/<self>` would diff to nothing).
 * Explicit wins, then the remote's default branch, then the usual names.
 * Returns null if nothing resolves.
 */
export function resolveBase(explicit: string | null): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  try {
    candidates.push(git(['rev-parse', '--abbrev-ref', 'origin/HEAD']).trim());
  } catch {
    /* origin/HEAD not set locally */
  }
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  return candidates.find((ref) => ref && refExists(ref)) ?? null;
}

/** Split a unified diff into one string per file, keyed by the new path. */
export function splitByFile(diff: string): { file: string; chunk: string }[] {
  const parts = diff.split(/(?=^diff --git )/m).filter((p) => p.startsWith('diff --git '));
  return parts.map((chunk) => {
    const header = chunk.slice(0, chunk.indexOf('\n'));
    const m = header.match(/ b\/(.+)$/);
    return { file: m ? m[1]! : header.replace('diff --git ', ''), chunk };
  });
}

/** Keep whole-file chunks until the byte budget runs out. */
export function truncateDiff(
  diff: string,
  maxBytes: number,
): { diff: string; truncatedFiles: string[] } {
  if (Buffer.byteLength(diff) <= maxBytes) return { diff, truncatedFiles: [] };
  const kept: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  for (const { file, chunk } of splitByFile(diff)) {
    const size = Buffer.byteLength(chunk);
    if (used + size <= maxBytes) {
      kept.push(chunk);
      used += size;
    } else {
      dropped.push(file);
    }
  }
  return { diff: kept.join(''), truncatedFiles: dropped };
}

export interface CollectedDiff {
  diff: string;
  ctx: ReviewContext;
}

const EXCLUDES = [
  ':(exclude)pnpm-lock.yaml',
  ':(exclude)package-lock.json',
  ':(exclude)yarn.lock',
  ':(exclude)*.tsbuildinfo',
  ':(exclude)*.snap',
];

export function collectDiff(cfg: Config): CollectedDiff | null {
  const base = resolveBase(cfg.baseRef);
  if (!base) return null;

  // `headRef` lets CI diff a commit that is fetched but not checked out, so the
  // tool + prompts + config can run from a trusted ref while the PR head is data.
  const head = cfg.headRef ?? 'HEAD';
  if (!refExists(head)) return null;

  const range = ['--merge-base', base, head];
  const names = git(['diff', ...range, '--name-only', '--', '.', ...EXCLUDES])
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) return null;

  const raw = git(['diff', ...range, '-U3', '--', '.', ...EXCLUDES]);
  const { diff, truncatedFiles } = truncateDiff(raw, cfg.maxDiffBytes);
  if (diff.trim().length === 0) return null;

  return {
    diff,
    ctx: {
      base,
      head: git(['rev-parse', '--short', head]).trim(),
      changedFiles: names,
      truncatedFiles,
    },
  };
}
