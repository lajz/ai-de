import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SEVERITIES, type Finding, type ReviewContext, type Severity, type Sink } from './types.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no I/O)
// ---------------------------------------------------------------------------

const SUMMARY_MARKER = '<!-- fde-review:summary -->';
const KEY_RE = /<!--\s*fde-review:key=([a-f0-9]{10})\s*-->/;
const STATE_RE = /<!--\s*fde-review:state\s+run=(\d+)\s+verdict=(approve|block)\s*-->/i;

const SEV_EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', nit: '⚪' };
const rank = (s: Severity): number => SEVERITIES.indexOf(s);

/** Stable per-finding id: survives line shifts, keyed on pass + file + title. */
export function findingKey(f: Finding): string {
  const slug = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return createHash('sha1').update(`${f.pass} :: ${f.file} :: ${slug}`).digest('hex').slice(0, 10);
}

export function markerFor(key: string): string {
  return `<!-- fde-review:key=${key} -->`;
}

export function keyFromBody(body: string): string | null {
  return body.match(KEY_RE)?.[1] ?? null;
}

export function commentBody(f: Finding, key: string): string {
  const parts = [
    `${SEV_EMOJI[f.severity]} **${f.severity.toUpperCase()} · ${f.pass}** — ${f.title}`,
    '',
    f.detail,
  ];
  if (f.suggestion) parts.push('', `_Suggested fix:_ ${f.suggestion}`);
  parts.push('', markerFor(key));
  return parts.join('\n');
}

export interface ThreadInfo {
  key: string;
  threadId: string;
  isResolved: boolean;
  rootCommentId: number;
}

export interface ActionPlan {
  toCreate: Finding[];
  toResolve: ThreadInfo[];
  toReopen: ThreadInfo[];
  stillOpen: { finding: Finding; thread: ThreadInfo }[];
}

/** Diff the current findings against the review threads fde-review already owns. */
export function planActions(findings: Finding[], threads: ThreadInfo[]): ActionPlan {
  const current = new Map(findings.map((f) => [findingKey(f), f]));
  const mine = new Map(threads.map((t) => [t.key, t]));

  const toCreate: Finding[] = [];
  const toReopen: ThreadInfo[] = [];
  const stillOpen: { finding: Finding; thread: ThreadInfo }[] = [];
  for (const [key, finding] of current) {
    const thread = mine.get(key);
    if (!thread) toCreate.push(finding);
    else if (thread.isResolved) toReopen.push(thread);
    else stillOpen.push({ finding, thread });
  }

  const toResolve: ThreadInfo[] = [];
  for (const [key, thread] of mine) {
    if (!current.has(key) && !thread.isResolved) toResolve.push(thread);
  }

  return { toCreate, toResolve, toReopen, stillOpen };
}

export interface Verdict {
  blocking: Finding[];
  approve: boolean;
}

export function computeVerdict(findings: Finding[], blockingSeverity: Severity): Verdict {
  const blocking = findings.filter((f) => rank(f.severity) <= rank(blockingSeverity));
  return { blocking, approve: blocking.length === 0 };
}

export function parsePrevState(summaryBody: string | null): {
  run: number;
  verdict: 'approve' | 'block' | null;
} {
  const m = summaryBody?.match(STATE_RE);
  if (!m) return { run: 0, verdict: null };
  return { run: Number(m[1]), verdict: m[2]!.toLowerCase() as 'approve' | 'block' };
}

const short = (sha: string): string => sha.slice(0, 7);

export interface SummaryInput {
  model: string;
  base: string;
  headSha: string;
  run: number;
  findings: Finding[];
  plan: ActionPlan;
  resolvedThisRun: number;
  verdict: Verdict;
  blockingSeverity: Severity;
  unpositioned: Finding[];
}

export function renderSummary(s: SummaryInput): string {
  const rows: string[] = [];
  const newKeys = new Set(s.plan.toCreate.map(findingKey));
  const sorted = [...s.findings].sort(
    (a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file),
  );
  for (const f of sorted) {
    const loc = f.line ? `\`${f.file}:${f.line}\`` : `\`${f.file}\``;
    const tag = newKeys.has(findingKey(f)) ? '🆕' : '📌';
    rows.push(`| ${tag} | ${f.severity.toUpperCase()} | ${f.pass} | ${loc} | ${f.title} |`);
  }

  const verdictLine = s.verdict.approve
    ? '**Verdict: ✅ no blocking findings**'
    : `**Verdict: ❌ ${s.verdict.blocking.length} blocking finding(s) at or above \`${s.blockingSeverity}\` — approval withheld**`;

  const out = [
    `## 🤖 AI review — \`${s.model}\``,
    '',
    `Reviewed \`${short(s.headSha)}\` against \`${short(s.base)}\` · run ${s.run}`,
    '',
    verdictLine,
    '',
  ];

  if (rows.length) {
    out.push(
      '| | Sev | Pass | Location | Finding |',
      '| --- | --- | --- | --- | --- |',
      ...rows,
      '',
    );
  } else {
    out.push('_No open findings._', '');
  }

  if (s.plan.toResolve.length || s.resolvedThisRun) {
    out.push(`✅ Resolved ${s.plan.toResolve.length} thread(s) this run.`, '');
  }
  if (s.plan.toReopen.length) {
    out.push(
      `⚠️ Reopened ${s.plan.toReopen.length} thread(s) — previously-fixed issues resurfaced.`,
      '',
    );
  }
  if (s.unpositioned.length) {
    out.push(
      '<details><summary>Findings not attached to a line (outside the diff)</summary>',
      '',
      ...s.unpositioned.map(
        (f) => `- **${f.severity.toUpperCase()}** \`${f.file}\` — ${f.title}: ${f.detail}`,
      ),
      '',
      '</details>',
      '',
    );
  }

  out.push(
    `<sub>Comments, resolutions, and the verdict on this PR are managed by \`fde-review\`. Re-runs on each push.</sub>`,
    '',
    `<!-- fde-review:state run=${s.run} verdict=${s.verdict.approve ? 'approve' : 'block'} -->`,
    SUMMARY_MARKER,
  );
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// gh CLI wrappers
// ---------------------------------------------------------------------------

export interface PrContext {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
}

function makeGh(token: string | undefined) {
  const env = { ...process.env };
  if (token) env.GH_TOKEN = token;
  return (args: string[], input?: string): string =>
    execFileSync('gh', args, { encoding: 'utf8', env, input, maxBuffer: 32 * 1024 * 1024 });
}

type Gh = ReturnType<typeof makeGh>;

function ghApi<T>(gh: Gh, method: string, path: string, body?: unknown): T {
  const args = ['api', '--method', method, path];
  if (body !== undefined) args.push('--input', '-');
  const out = gh(args, body === undefined ? undefined : JSON.stringify(body));
  return (out.trim() ? JSON.parse(out) : undefined) as T;
}

/** GET a paginated list endpoint, returning the flattened array. */
function ghApiList<T>(gh: Gh, path: string): T[] {
  const out = gh(['api', '--paginate', path, '--jq', '.[]']);
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function ghGraphql<T>(gh: Gh, query: string, variables: Record<string, unknown>): T {
  const out = gh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }));
  return JSON.parse(out) as T;
}

function resolvePrContext(gh: Gh): PrContext {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (eventPath) {
    const ev = JSON.parse(readFileSync(eventPath, 'utf8')) as {
      pull_request?: { number: number; head: { sha: string } };
    };
    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/');
    if (ev.pull_request && owner && repo) {
      return { owner, repo, number: ev.pull_request.number, headSha: ev.pull_request.head.sha };
    }
  }
  const view = JSON.parse(gh(['pr', 'view', '--json', 'number,headRefOid'])) as {
    number: number;
    headRefOid: string;
  };
  const nwo = JSON.parse(gh(['repo', 'view', '--json', 'owner,name'])) as {
    owner: { login: string };
    name: string;
  };
  return { owner: nwo.owner.login, repo: nwo.name, number: view.number, headSha: view.headRefOid };
}

interface ReviewThreadsResponse {
  data: {
    repository: {
      pullRequest: {
        reviewThreads: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: {
            id: string;
            isResolved: boolean;
            comments: { nodes: { databaseId: number; body: string }[] };
          }[];
        };
      };
    };
  };
}

const THREADS_QUERY = `
query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved comments(first:1){ nodes{ databaseId body } } }
      }
    }
  }
}`;

// ---------------------------------------------------------------------------
// The sink
// ---------------------------------------------------------------------------

export interface GitHubSinkOptions {
  token: string | undefined;
  blockingSeverity: Severity;
  model: string;
  requestChanges: boolean;
}

function note(msg: string): void {
  process.stdout.write(`fde-review: ${msg}\n`);
}

export class GitHubSink implements Sink {
  private readonly gh: Gh;

  constructor(private readonly opts: GitHubSinkOptions) {
    this.gh = makeGh(opts.token);
  }

  async emit(findings: Finding[], ctx: ReviewContext): Promise<void> {
    let pr: PrContext;
    try {
      pr = resolvePrContext(this.gh);
    } catch (err) {
      const why = /ENOENT/.test(String(err)) ? 'gh CLI not found' : 'no open PR for this branch';
      note(`${why} — skipping github sink`);
      return;
    }

    const { threads, ok } = this.fetchOwnThreads(pr);
    const plan = planActions(findings, threads);
    const repoPath = `repos/${pr.owner}/${pr.repo}`;

    const unpositioned: Finding[] = [];
    if (ok) {
      for (const finding of plan.toCreate) {
        const key = findingKey(finding);
        if (finding.line == null || !this.postInline(repoPath, pr, finding, key)) {
          unpositioned.push(finding);
        }
      }
    } else {
      // Thread read failed — creating comments now would duplicate existing ones.
      note('github: skipping new comments this run (could not confirm existing threads)');
      unpositioned.push(...plan.toCreate);
    }

    for (const thread of plan.toResolve) {
      this.reply(
        repoPath,
        pr.number,
        thread.rootCommentId,
        `✅ Resolved — no longer flagged as of \`${short(pr.headSha)}\`.`,
      );
      this.setResolved(thread.threadId, true);
    }
    for (const thread of plan.toReopen) {
      this.setResolved(thread.threadId, false);
      this.reply(
        repoPath,
        pr.number,
        thread.rootCommentId,
        `⚠️ Reopened — still flagged as of \`${short(pr.headSha)}\`.`,
      );
    }

    const prev = this.fetchSummary(pr);
    const prevState = parsePrevState(prev?.body ?? null);
    const run = prevState.run + 1;
    const verdict = computeVerdict(findings, this.opts.blockingSeverity);

    const body = renderSummary({
      model: this.opts.model,
      base: gitShaOf(ctx.base) ?? ctx.base,
      headSha: pr.headSha,
      run,
      findings,
      plan,
      resolvedThisRun: plan.toResolve.length,
      verdict,
      blockingSeverity: this.opts.blockingSeverity,
      unpositioned,
    });
    this.upsertSummary(repoPath, pr.number, prev?.id ?? null, body);

    const nextVerdict = verdict.approve ? 'approve' : 'block';
    if (prevState.verdict !== nextVerdict) {
      this.submitVerdict(pr, verdict);
    } else {
      note(`github: verdict unchanged (${nextVerdict}) — no new review submitted`);
    }

    note(
      `github: ${plan.toCreate.length - unpositioned.length} new comment(s), ` +
        `${unpositioned.length} unpositioned, ${plan.toResolve.length} resolved, ` +
        `${plan.toReopen.length} reopened, ${plan.stillOpen.length} still open`,
    );
  }

  private fetchOwnThreads(pr: PrContext): { threads: ThreadInfo[]; ok: boolean } {
    const out: ThreadInfo[] = [];
    let cursor: string | null = null;
    try {
      for (;;) {
        const res: ReviewThreadsResponse = ghGraphql(this.gh, THREADS_QUERY, {
          owner: pr.owner,
          repo: pr.repo,
          num: pr.number,
          cursor,
        });
        const page = res.data.repository.pullRequest.reviewThreads;
        for (const node of page.nodes) {
          const root = node.comments.nodes[0];
          if (!root) continue;
          const key = keyFromBody(root.body);
          if (key) {
            out.push({
              key,
              threadId: node.id,
              isResolved: node.isResolved,
              rootCommentId: root.databaseId,
            });
          }
        }
        if (!page.pageInfo.hasNextPage) break;
        cursor = page.pageInfo.endCursor;
      }
    } catch (err) {
      note(`github: could not read existing threads (${firstLine(err)})`);
      return { threads: out, ok: false };
    }
    return { threads: out, ok: true };
  }

  private fetchSummary(pr: PrContext): { id: number; body: string } | null {
    try {
      const comments = ghApiList<{ id: number; body: string }>(
        this.gh,
        `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments?per_page=100`,
      );
      return comments.find((c) => c.body.includes(SUMMARY_MARKER)) ?? null;
    } catch {
      return null;
    }
  }

  private postInline(repoPath: string, pr: PrContext, f: Finding, key: string): boolean {
    try {
      ghApi(this.gh, 'POST', `${repoPath}/pulls/${pr.number}/comments`, {
        body: commentBody(f, key),
        commit_id: pr.headSha,
        path: f.file,
        line: f.line,
        side: 'RIGHT',
      });
      return true;
    } catch (err) {
      note(`github: could not attach comment to ${f.file}:${f.line} (${firstLine(err)})`);
      return false;
    }
  }

  private reply(repoPath: string, prNumber: number, rootCommentId: number, body: string): void {
    try {
      ghApi(this.gh, 'POST', `${repoPath}/pulls/${prNumber}/comments/${rootCommentId}/replies`, {
        body,
      });
    } catch (err) {
      note(`github: could not reply on thread ${rootCommentId} (${firstLine(err)})`);
    }
  }

  private setResolved(threadId: string, resolved: boolean): void {
    const mutation = resolved
      ? 'mutation($id:ID!){resolveReviewThread(input:{threadId:$id}){thread{isResolved}}}'
      : 'mutation($id:ID!){unresolveReviewThread(input:{threadId:$id}){thread{isResolved}}}';
    try {
      ghGraphql(this.gh, mutation, { id: threadId });
    } catch (err) {
      note(`github: could not ${resolved ? 'resolve' : 'reopen'} thread (${firstLine(err)})`);
    }
  }

  private upsertSummary(repoPath: string, prNumber: number, id: number | null, body: string): void {
    try {
      if (id) ghApi(this.gh, 'PATCH', `${repoPath}/issues/comments/${id}`, { body });
      else ghApi(this.gh, 'POST', `${repoPath}/issues/${prNumber}/comments`, { body });
    } catch (err) {
      note(`github: could not write summary comment (${firstLine(err)})`);
    }
  }

  private submitVerdict(pr: PrContext, verdict: Verdict): void {
    const repo = `${pr.owner}/${pr.repo}`;
    const num = String(pr.number);
    if (verdict.approve) {
      const body = '✅ **fde-review**: no blocking findings.';
      if (!this.tryReview(['--approve', '--body', body], repo, num)) {
        this.comment(
          pr,
          `${body} _(formal approval skipped — reviewer identity is the PR author)_`,
        );
      }
      return;
    }
    const body = `❌ **fde-review**: ${verdict.blocking.length} blocking finding(s) at or above \`${this.opts.blockingSeverity}\`. Approval withheld until resolved.`;
    const event = this.opts.requestChanges ? '--request-changes' : '--comment';
    if (!this.tryReview([event, '--body', body], repo, num)) {
      this.comment(pr, body);
    }
  }

  private tryReview(reviewArgs: string[], repo: string, num: string): boolean {
    try {
      this.gh(['pr', 'review', num, '--repo', repo, ...reviewArgs]);
      return true;
    } catch {
      return false;
    }
  }

  private comment(pr: PrContext, body: string): void {
    try {
      ghApi(this.gh, 'POST', `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`, { body });
    } catch (err) {
      note(`github: could not post verdict comment (${firstLine(err)})`);
    }
  }
}

function firstLine(err: unknown): string {
  return String((err as Error).message ?? err)
    .split('\n')[0]!
    .slice(0, 200);
}

function gitShaOf(ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}
