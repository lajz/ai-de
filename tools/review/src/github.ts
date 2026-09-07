import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { SEVERITIES, type Finding, type ReviewContext, type Severity, type Sink } from './types.js';

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested; no I/O)
// ---------------------------------------------------------------------------

const SUMMARY_MARKER = '<!-- fde-review:summary -->';
const MARKER_RE = /<!--\s*fde-review:key=([a-f0-9]{10})(?:\s+pass=([a-z]+))?\s*-->/;
const STATE_RE =
  /<!--\s*fde-review:state\s+run=(\d+)\s+verdict=(approve|block)(?:\s+submitted=([01]))?\s*-->/i;

const SEV_EMOJI: Record<Severity, string> = { high: '🔴', medium: '🟠', low: '🟡', nit: '⚪' };
const rank = (s: Severity): number => SEVERITIES.indexOf(s);

/**
 * Model output is untrusted: a crafted diff can make it echo back an HTML comment
 * that would forge one of our markers, or break out of a table cell. Defang the
 * comment delimiters and collapse newlines; callers escape `|` for table cells.
 */
export function clean(s: string): string {
  return s
    .replace(/<!--+/g, '&lt;!--')
    .replace(/--+>/g, '--&gt;')
    .replace(/\r?\n+/g, ' ')
    .trim();
}

const cell = (s: string): string => clean(s).replace(/\|/g, '\\|');

/** Stable per-finding id: survives line shifts, keyed on pass + file + title. */
export function findingKey(f: Finding): string {
  const slug = f.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return createHash('sha1').update(`${f.pass} :: ${f.file} :: ${slug}`).digest('hex').slice(0, 10);
}

export function markerFor(key: string, pass: string): string {
  return `<!-- fde-review:key=${key} pass=${pass.replace(/[^a-z]/gi, '')} -->`;
}

export interface Marker {
  key: string;
  /** null for comments written before pass= was added to the marker */
  pass: string | null;
}

export function parseMarker(body: string): Marker | null {
  const m = body.match(MARKER_RE);
  return m ? { key: m[1]!, pass: m[2] ?? null } : null;
}

export function keyFromBody(body: string): string | null {
  return parseMarker(body)?.key ?? null;
}

export function commentBody(f: Finding, key: string): string {
  const parts = [
    `${SEV_EMOJI[f.severity]} **${f.severity.toUpperCase()} · ${clean(f.pass)}** — ${clean(f.title)}`,
    '',
    clean(f.detail),
  ];
  if (f.suggestion) parts.push('', `_Suggested fix:_ ${clean(f.suggestion)}`);
  parts.push('', markerFor(key, f.pass));
  return parts.join('\n');
}

export interface ThreadInfo {
  key: string;
  pass: string | null;
  path: string | null;
  line: number | null;
  threadId: string;
  isResolved: boolean;
  rootCommentId: number;
  /** We already left a "no longer flagged, resolve manually" note on this thread. */
  noted: boolean;
  /** A human replied "/fp" / "false positive" — an explicit dismissal. */
  dismissReply: boolean;
  /** A person resolved the thread (not fde-review closing out a fix). */
  humanResolved: boolean;
  /** We already acknowledged a dismissal. */
  acked: boolean;
}

/**
 * A finding is dismissed when a human explicitly waved it off, or resolved its
 * thread while the reviewer is still reporting it (i.e. they're overriding, not
 * just tidying up after a fix). `stillReported` = the finding is in this run.
 */
export function isDismissed(thread: ThreadInfo, stillReported: boolean): boolean {
  return thread.dismissReply || (thread.humanResolved && stillReported);
}

export interface ActionPlan {
  toCreate: Finding[];
  toResolve: ThreadInfo[];
  toReopen: ThreadInfo[];
  stillOpen: { finding: Finding; thread: ThreadInfo }[];
}

export interface PlanOptions {
  /** Passes that errored — their threads must not be resolved (we have no data). */
  failedPasses?: string[];
  /** Suppress a keyless new finding within this many lines of an open thread on the same file. */
  positionalWindow?: number;
}

/** Diff the current findings against the review threads fde-review already owns. */
export function planActions(
  findings: Finding[],
  threads: ThreadInfo[],
  opts: PlanOptions = {},
): ActionPlan {
  const failed = new Set(opts.failedPasses ?? []);
  const window = opts.positionalWindow ?? 3;
  const current = new Map(findings.map((f) => [findingKey(f), f]));
  const mine = new Map(threads.map((t) => [t.key, t]));
  const openThreads = threads.filter((t) => !t.isResolved);

  const toCreate: Finding[] = [];
  const toReopen: ThreadInfo[] = [];
  const stillOpen: { finding: Finding; thread: ThreadInfo }[] = [];
  for (const [key, finding] of current) {
    const thread = mine.get(key);
    if (thread) {
      if (thread.isResolved) toReopen.push(thread);
      else stillOpen.push({ finding, thread });
      continue;
    }
    // Backstop against a re-worded finding at the same spot — an existing open
    // thread, or another new finding already queued this run.
    const line = finding.line;
    const nearby = (path: string | null, other: number | null): boolean =>
      line != null && other != null && path === finding.file && Math.abs(other - line) <= window;
    if (openThreads.some((t) => nearby(t.path, t.line))) continue;
    if (toCreate.some((c) => nearby(c.file, c.line))) continue;
    toCreate.push(finding);
  }

  const toResolve: ThreadInfo[] = [];
  for (const [key, thread] of mine) {
    if (thread.isResolved || current.has(key)) continue;
    // A failed pass produced no findings; its silence is not evidence of a fix.
    if (thread.pass ? failed.has(thread.pass) : failed.size > 0) continue;
    toResolve.push(thread);
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

export interface PrevState {
  run: number;
  verdict: 'approve' | 'block' | null;
  /** Whether a formal `gh pr review` was submitted last time (vs only a comment). */
  submitted: boolean;
}

export function parsePrevState(summaryBody: string | null): PrevState {
  const m = summaryBody?.match(STATE_RE);
  if (!m) return { run: 0, verdict: null, submitted: false };
  return {
    run: Number(m[1]),
    verdict: m[2]!.toLowerCase() as 'approve' | 'block',
    submitted: m[3] === '1',
  };
}

const short = (sha: string): string => sha.slice(0, 7);

export interface SummaryInput {
  model: string;
  base: string;
  headSha: string;
  run: number;
  findings: Finding[];
  /** Findings a human waved off — shown separately, excluded from the verdict. */
  dismissed: Finding[];
  plan: ActionPlan;
  /** Threads actually resolved / reopened this run (API confirmed). */
  resolvedThisRun: number;
  reopenedThisRun: number;
  verdict: Verdict;
  blockingSeverity: Severity;
  unpositioned: Finding[];
  /** Passes that errored out — the review is incomplete and must not approve. */
  failedPasses: string[];
  /** Whether a formal `gh pr review` was submitted this run — recorded in the state marker. */
  submitted: boolean;
}

export function renderSummary(s: SummaryInput): string {
  const rows: string[] = [];
  const newKeys = new Set(s.plan.toCreate.map(findingKey));
  const unpositioned = new Set(s.unpositioned);
  // The table lists line-anchored findings; the rest go in the details block below.
  const sorted = [...s.findings]
    .filter((f) => !unpositioned.has(f))
    .sort((a, b) => rank(a.severity) - rank(b.severity) || a.file.localeCompare(b.file));
  for (const f of sorted) {
    const tag = newKeys.has(findingKey(f)) ? '🆕' : '📌';
    rows.push(
      `| ${tag} | ${f.severity.toUpperCase()} | ${cell(f.pass)} | \`${cell(f.file)}:${f.line}\` | ${cell(f.title)} |`,
    );
  }

  const verdictLine = s.failedPasses.length
    ? `**Verdict: ⚠️ review incomplete — the ${s.failedPasses.join(' and ')} pass did not finish; approval withheld**`
    : s.verdict.approve
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
  } else if (!s.unpositioned.length) {
    out.push('_No open findings._', '');
  }

  if (s.resolvedThisRun) {
    out.push(`✅ Resolved ${s.resolvedThisRun} thread(s) this run.`, '');
  }
  if (s.reopenedThisRun) {
    out.push(
      `⚠️ Reopened ${s.reopenedThisRun} thread(s) — previously-fixed issues resurfaced.`,
      '',
    );
  }
  if (s.unpositioned.length) {
    out.push(
      '<details><summary>Findings not attached to a line (outside the diff)</summary>',
      '',
      ...s.unpositioned.map(
        (f) =>
          `- **${f.severity.toUpperCase()}** \`${clean(f.file)}\` — ${clean(f.title)}: ${clean(f.detail)}`,
      ),
      '',
      '</details>',
      '',
    );
  }
  if (s.dismissed.length) {
    out.push(
      `<details><summary>🚫 Dismissed as false positives (${s.dismissed.length})</summary>`,
      '',
      ...s.dismissed.map((f) => {
        const loc = f.line ? `\`${clean(f.file)}:${f.line}\`` : `\`${clean(f.file)}\``;
        return `- **${f.severity.toUpperCase()}** ${loc} — ${clean(f.title)}`;
      }),
      '',
      '</details>',
      '',
    );
  }

  out.push(
    `<sub>Comments, resolutions, and the verdict on this PR are managed by \`fde-review\`. Re-runs on each push. Disagree with a finding? Resolve its thread or reply "false positive" / "/fp".</sub>`,
    '',
    `<!-- fde-review:state run=${s.run} verdict=${s.verdict.approve ? 'approve' : 'block'} submitted=${s.submitted ? 1 : 0} -->`,
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
  return (args: string[], input?: string): string => {
    try {
      return execFileSync('gh', args, {
        encoding: 'utf8',
        env,
        input,
        maxBuffer: 32 * 1024 * 1024,
      });
    } catch (err) {
      // execFileSync's message is just the command line; gh's API error is on stderr/stdout.
      const e = err as Error & { stderr?: unknown; stdout?: unknown };
      const detail = [e.stderr, e.stdout]
        .map((x) => (x == null ? '' : String(x)))
        .join(' ')
        .trim();
      if (detail) e.message = detail;
      throw err;
    }
  };
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
            path: string | null;
            line: number | null;
            originalLine: number | null;
            comments: { nodes: { databaseId: number; body: string }[] };
          }[];
        };
      };
    };
  };
}

const NOTED_MARKER = '<!-- fde-review:noted -->';
const RESOLVED_MARKER = '<!-- fde-review:resolved -->';
const ACKED_MARKER = '<!-- fde-review:acked -->';
const BOT_REPLY_MARKER = '<!-- fde-review:bot -->';

/** A comment fde-review wrote carries a marker (newer) or matches its known text (older). */
const isOurComment = (body: string): boolean =>
  /<!--\s*fde-review/i.test(body) || /✅ (Resolved|No longer flagged) —/.test(body);

/** A human reply that waves a finding off. Only matched on comments we did not write. */
const DISMISS_RE =
  /(^|\s)\/(fp|dismiss)\b|false[ -]?positive|not a (real |genuine )?(bug|issue|problem|concern)|working as intended|by design/i;

/** Did a human reply explicitly wave this finding off? */
export function hasDismissReply(commentBodies: string[]): boolean {
  return commentBodies.some((b) => !isOurComment(b) && DISMISS_RE.test(b));
}

/** Was this thread resolved by a person rather than by fde-review closing out a fix? */
export function humanResolved(threadIsResolved: boolean, commentBodies: string[]): boolean {
  if (!threadIsResolved) return false;
  return !commentBodies.some(
    (b) => b.includes(RESOLVED_MARKER) || /✅ (Resolved|No longer flagged) —/.test(b),
  );
}

const THREADS_QUERY = `
query($owner:String!,$repo:String!,$num:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$num){
      reviewThreads(first:100,after:$cursor){
        pageInfo{ hasNextPage endCursor }
        nodes{ id isResolved path line originalLine comments(first:30){ nodes{ databaseId body } } }
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
  /** Passes that errored — forces a non-approving, "incomplete" verdict. */
  failedPasses: string[];
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
    const repoPath = `repos/${pr.owner}/${pr.repo}`;

    // Findings a human has waved off ("/fp", "false positive", or resolving the
    // thread while we're still reporting it) don't count toward the verdict, get
    // a "🚫 Dismissed" line in the summary, and aren't re-raised.
    const reportedKeys = new Set(findings.map(findingKey));
    const dismissedThreads = threads.filter((t) => isDismissed(t, reportedKeys.has(t.key)));
    const dismissedKeys = new Set(dismissedThreads.map((t) => t.key));
    const live = findings.filter((f) => !dismissedKeys.has(findingKey(f)));
    const dismissed = findings.filter((f) => dismissedKeys.has(findingKey(f)));

    for (const thread of dismissedThreads) {
      if (!thread.acked && (!thread.isResolved || thread.dismissReply)) {
        this.reply(
          repoPath,
          pr.number,
          thread.rootCommentId,
          `Acknowledged — treating this as a false positive: dropped from the verdict, won't re-raise it. ${ACKED_MARKER}`,
        );
        if (!thread.isResolved) this.setResolved(thread.threadId, true); // best effort
      }
    }

    const plan = planActions(
      live,
      threads.filter((t) => !dismissedKeys.has(t.key)),
      { failedPasses: this.opts.failedPasses },
    );

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

    const sha = short(pr.headSha);
    let resolvedCount = 0;
    for (const thread of plan.toResolve) {
      if (this.setResolved(thread.threadId, true)) {
        resolvedCount++;
        this.reply(
          repoPath,
          pr.number,
          thread.rootCommentId,
          `✅ Resolved — no longer flagged as of \`${sha}\`. ${RESOLVED_MARKER}`,
        );
      } else if (!thread.noted) {
        // Token can't resolve threads (plain GITHUB_TOKEN can't) — leave one note.
        this.reply(
          repoPath,
          pr.number,
          thread.rootCommentId,
          `✅ No longer flagged as of \`${sha}\` — resolve this thread when you're satisfied. ${NOTED_MARKER}`,
        );
      }
    }
    let reopenedCount = 0;
    for (const thread of plan.toReopen) {
      if (this.setResolved(thread.threadId, false)) {
        reopenedCount++;
        this.reply(
          repoPath,
          pr.number,
          thread.rootCommentId,
          `⚠️ Reopened — still flagged as of \`${short(pr.headSha)}\`.`,
        );
      }
    }

    const prev = this.fetchSummary(pr);
    const prevState = parsePrevState(prev?.body ?? null);
    const run = prevState.run + 1;
    const failedPasses = this.opts.failedPasses;
    const verdict = computeVerdict(live, this.opts.blockingSeverity);
    // An incomplete review cannot vouch for the PR.
    if (failedPasses.length) verdict.approve = false;

    // Submit the review BEFORE writing the summary, and record whether the formal
    // `gh pr review` actually went through — so a transient failure retries next
    // run instead of being masked by an unchanged verdict.
    const nextVerdict = verdict.approve ? 'approve' : 'block';
    const verdictChanged = prevState.verdict !== nextVerdict;
    let submitted = prevState.submitted;
    if (verdictChanged || !prevState.submitted) {
      submitted = this.submitVerdict(pr, verdict, failedPasses, { comment: verdictChanged });
    } else {
      note(`github: verdict unchanged (${nextVerdict}) — no new review submitted`);
    }

    const body = renderSummary({
      model: this.opts.model,
      base: gitShaOf(ctx.base) ?? ctx.base,
      headSha: pr.headSha,
      run,
      findings: live,
      dismissed,
      plan,
      resolvedThisRun: resolvedCount,
      reopenedThisRun: reopenedCount,
      verdict,
      blockingSeverity: this.opts.blockingSeverity,
      unpositioned,
      failedPasses,
      submitted,
    });
    this.upsertSummary(repoPath, pr.number, prev?.id ?? null, body);

    note(
      `github: ${plan.toCreate.length - unpositioned.length} new comment(s), ` +
        `${unpositioned.length} unpositioned, ${resolvedCount} resolved, ` +
        `${reopenedCount} reopened, ${plan.stillOpen.length} still open, ` +
        `${dismissed.length} dismissed`,
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
          const marker = parseMarker(root.body);
          if (marker) {
            const bodies = node.comments.nodes.map((c) => c.body);
            out.push({
              key: marker.key,
              pass: marker.pass,
              path: node.path,
              line: node.line ?? node.originalLine,
              threadId: node.id,
              isResolved: node.isResolved,
              rootCommentId: root.databaseId,
              noted: bodies.some((b) => b.includes(NOTED_MARKER)),
              dismissReply: hasDismissReply(bodies),
              humanResolved: humanResolved(node.isResolved, bodies),
              acked: bodies.some((b) => b.includes(ACKED_MARKER)),
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
      // ghApiList follows pagination, so this sees every comment on the PR.
      const comments = ghApiList<{ id: number; body: string }>(
        this.gh,
        `repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`,
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
    // Every reply carries a marker so a later dismissal scan can tell our
    // comments from a human's.
    const tagged = /<!--\s*fde-review/i.test(body) ? body : `${body} ${BOT_REPLY_MARKER}`;
    try {
      ghApi(this.gh, 'POST', `${repoPath}/pulls/${prNumber}/comments/${rootCommentId}/replies`, {
        body: tagged,
      });
    } catch (err) {
      note(`github: could not reply on thread ${rootCommentId} (${firstLine(err)})`);
    }
  }

  private resolveDisabled = false;

  /** Returns whether the thread ended up in the requested state. */
  private setResolved(threadId: string, resolved: boolean): boolean {
    if (this.resolveDisabled) return false;
    const field = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    try {
      const res = ghGraphql<{ data?: Record<string, { thread?: { isResolved?: boolean } }> }>(
        this.gh,
        `mutation($id:ID!){${field}(input:{threadId:$id}){thread{isResolved}}}`,
        { id: threadId },
      );
      const got = res.data?.[field]?.thread?.isResolved;
      if (got === resolved) return true;
      note(`github: ${field} did not take for thread ${threadId}`);
      return false;
    } catch (err) {
      const msg = firstLine(err);
      if (/not accessible by integration|forbidden|resolve.*permission/i.test(msg)) {
        this.resolveDisabled = true;
        note(
          "github: this token can't resolve review threads — leaving a note instead. " +
            'Set a fine-grained PAT as the REVIEW_BOT_TOKEN secret to enable it.',
        );
      } else {
        note(`github: could not ${resolved ? 'resolve' : 'reopen'} thread (${msg})`);
      }
      return false;
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

  /** Returns whether a formal `gh pr review` went through. */
  private submitVerdict(
    pr: PrContext,
    verdict: Verdict,
    failedPasses: string[],
    opts: { comment: boolean },
  ): boolean {
    const repo = `${pr.owner}/${pr.repo}`;
    const num = String(pr.number);
    if (verdict.approve) {
      const body = '✅ **fde-review**: no blocking findings.';
      if (this.tryReview(['--approve', '--body', body], repo, num)) return true;
      if (opts.comment) {
        this.comment(
          pr,
          `${body}\n\n_Formal approval unavailable to this token — the PR author can't approve their own PR, and \`github-actions[bot]\` needs "Allow GitHub Actions to … approve pull requests" (Settings → Actions → General) or a \`REVIEW_BOT_TOKEN\`._`,
        );
      }
      return false;
    }
    const body = failedPasses.length
      ? `⚠️ **fde-review**: review incomplete — the ${failedPasses.join(' and ')} pass did not finish. Approval withheld; re-run the workflow.`
      : `❌ **fde-review**: ${verdict.blocking.length} blocking finding(s) at or above \`${this.opts.blockingSeverity}\`. Approval withheld until resolved.`;
    // "incomplete" is a soft state — always a comment, never REQUEST_CHANGES.
    const event =
      this.opts.requestChanges && !failedPasses.length ? '--request-changes' : '--comment';
    if (this.tryReview([event, '--body', body], repo, num)) return true;
    if (opts.comment) this.comment(pr, body);
    return false;
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
