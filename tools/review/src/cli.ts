import { pathToFileURL } from 'node:url';

import { canCallModel, loadConfig } from './config.js';
import { collectDiff } from './diff.js';
import { GitHubSink } from './github.js';
import { dedupeFindings, runPass } from './passes.js';
import { TerminalSink } from './report.js';
import { SEVERITIES, type Config, type Finding, type Retraction, type Severity } from './types.js';

const HELP = `fde-review — advisory AI review of the current branch vs its base

Usage: pnpm review [options]

Options:
  --base <ref>          Diff against this ref (default: origin/HEAD, else origin/main, else master)
  --head <ref>          Head of the diff (default: HEAD; CI uses a fetched PR-head sha)
  --min <severity>      Lowest severity to print: high|medium|low|nit (default: nit)
  --review-only         Skip the security pass
  --security-only       Skip the general review pass
  --sink <name>         terminal (default) or github (inline PR comments via gh)
  --fail-on <severity>  Exit non-zero if a finding at or above this severity exists
  --request-changes     github sink: submit REQUEST_CHANGES (not just a comment) when blocked
  --help

Model config comes from .env / environment:
  REVIEW_API_KEY, REVIEW_BASE_URL (default https://api.deepseek.com),
  REVIEW_MODEL (default deepseek-v4-flash). Use REVIEW_MODEL=claude to shell out
  to the Claude CLI, or point REVIEW_BASE_URL at a local Ollama.
  REVIEW_MAX_TOKENS (default 64000) caps completion tokens per call — raise it if
  a large PR's review keeps hitting the token limit before finishing.

github sink: needs an open PR for the branch and a token — the ambient gh login,
or REVIEW_GH_TOKEN / REVIEW_BOT_TOKEN / GH_TOKEN. A PAT with "Pull requests:
write" can resolve threads; a plain GITHUB_TOKEN can't (it leaves a note). Posts
findings as inline review comments, resolves them on re-review, and approves when
no finding is at or above blockingSeverity (default high; see .fde-review.json).

Exits 0 unless --fail-on matches.`;

interface Args {
  overrides: Partial<Config>;
  sink: string;
  requestChanges: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Args {
  const overrides: Partial<Config> = {};
  let sink = 'terminal';
  let requestChanges = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--':
        break;
      case '--base':
        overrides.baseRef = argv[++i] ?? null;
        break;
      case '--head':
        overrides.headRef = argv[++i] ?? null;
        break;
      case '--min': {
        const v = argv[++i];
        if (SEVERITIES.includes(v as Severity)) overrides.minSeverity = v as Severity;
        break;
      }
      case '--fail-on': {
        const v = argv[++i];
        if (SEVERITIES.includes(v as Severity)) overrides.failOn = v as Severity;
        break;
      }
      case '--review-only':
        overrides.passes = { review: true, security: false };
        break;
      case '--security-only':
        overrides.passes = { review: false, security: true };
        break;
      case '--sink':
        sink = argv[++i] ?? 'terminal';
        break;
      case '--request-changes':
        requestChanges = true;
        break;
      case '--help':
      case '-h':
        help = true;
        break;
      default:
        process.stderr.write(`fde-review: ignoring unknown argument "${arg}"\n`);
    }
  }
  return { overrides, sink, requestChanges, help };
}

function note(msg: string): void {
  process.stdout.write(`fde-review: ${msg}\n`);
}

async function main(): Promise<void> {
  const { overrides, sink, requestChanges, help } = parseArgs(process.argv.slice(2));
  if (help) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (sink !== 'terminal' && sink !== 'github') {
    note(`unknown sink "${sink}" — falling back to terminal`);
  }

  const cfg = loadConfig(overrides);

  const collected = collectDiff(cfg);
  if (!collected) {
    note('no reviewable changes vs base — skipping');
    return;
  }
  const { diff, ctx } = collected;

  if (!canCallModel(cfg)) {
    note('REVIEW_API_KEY not set — skipping AI review (deterministic checks still ran)');
    return;
  }

  const passes: string[] = [];
  if (cfg.passes.review) passes.push('review');
  if (cfg.passes.security) passes.push('security');

  const failedPasses: string[] = [];
  const github =
    sink === 'github'
      ? new GitHubSink({
          token:
            process.env.REVIEW_GH_TOKEN ??
            process.env.REVIEW_BOT_TOKEN ??
            process.env.GH_TOKEN ??
            process.env.GITHUB_TOKEN ??
            undefined,
          blockingSeverity: cfg.blockingSeverity,
          model: cfg.model,
          requestChanges,
          failedPasses,
        })
      : null;

  // On a re-review, hand each pass its own still-open findings so it can retract
  // any it no longer stands behind.
  const prior = github?.priorFindings() ?? [];

  note(`reviewing ${ctx.changedFiles.length} file(s) with ${cfg.model} …`);
  const raw: Finding[] = [];
  const retractions: Retraction[] = [];
  for (const name of passes) {
    try {
      const res = await runPass(
        name,
        diff,
        cfg,
        prior.filter((p) => p.pass === name),
      );
      raw.push(...res.findings);
      retractions.push(...res.retractions);
    } catch (err) {
      note(`${name} pass failed: ${(err as Error).message} — skipping`);
      failedPasses.push(name);
    }
  }
  const findings = dedupeFindings(raw);

  if (github) {
    await github.emit(findings, ctx, retractions);
  } else {
    await new TerminalSink(cfg.minSeverity).emit(findings, ctx);
  }

  if (cfg.failOn) {
    const threshold = SEVERITIES.indexOf(cfg.failOn);
    const hit = findings.filter((f) => SEVERITIES.indexOf(f.severity) <= threshold);
    if (hit.length) {
      note(`--fail-on ${cfg.failOn}: ${hit.length} finding(s) at or above threshold`);
      process.exitCode = 1;
    }
  }
}

const invokedDirectly =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    note(`unexpected error: ${(err as Error).message}`);
    process.exitCode = 0;
  });
}
