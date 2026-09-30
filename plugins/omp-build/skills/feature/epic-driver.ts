/**
 * epic-driver — the executable half of `/feature`'s Epic goal (#620, ADR-024 §1).
 *
 * Gathers the facts from GitHub and git, asks the pure core (`epic.ts`) for the
 * one next action, and performs the git transitions and GitHub markers that
 * action implies. A goal session calls it before every ticket and never relies
 * on its memory of earlier tickets.
 *
 *   objective --epic E                                  the /goal line (assisted, read-only)
 *   next      --epic E <gate> [--dry-run]               the next action; switches to the child branch
 *   stop      --epic E <gate> --ticket N --reason R     record a ticket stop (disarms the PR first)
 *   review    --epic E <gate> --verdict V --range A..B  record the final epic review
 *   hook      --epic E <gate> --repo <worktree>         run release.post_merge (cwd outside the repo)
 *   report    --epic E <gate> --outcome complete|drop   post the goal report (drop disarms every PR)
 *
 * <gate> is `--goal-status <status> --goal-objective <objective>` from
 * `goal({op:"get"})`: nothing but `objective` runs unless the goal is active and
 * names the epic; the run id and the base come from that objective.
 * Exit: 0 done · 1 failed (shared-state stop) · 2 refused · 3 assisted (no gate).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  type BaseCi,
  type BranchFacts,
  type ChildFacts,
  type Facts,
  formatMarker,
  generateObjective,
  goalRun,
  hasScope,
  mergedLocalBranches,
  nextStep,
  type PrFacts,
  parseEpicReview,
  parseGoalStop,
  parsePostMerge,
  type Report,
  readMarker,
  refuseForeignCommits,
  resolveTicketBranch,
  reviewExhausted,
  STICKY_STOPS,
  type Step,
  stopClass,
  summarize,
  TICKET_STOPS,
  ticketOfBranch,
  ticketOfSubject,
} from './epic'
import { type HookResult, runPostMergeHook } from './epic-close'
import { disarmReviewedBeforePush, MAX_FIX_ROUNDS, parseReviewRounds, readLanding } from './workflow.js'

class Refused extends Error {}
class Assisted extends Error {}

// ── Process helpers ──────────────────────────────────────────────────────────

const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']

function childEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env }
  for (const key of GIT_REDIRECTS) delete out[key]
  return out
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gh(repo: string, args: string[], input?: string): string {
  return execFileSync('gh', args, {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(),
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

/** One GraphQL call. `T` is the shape the query selects; GraphQL errors throw. */
function graphql<T>(repo: string, query: string, vars: Record<string, string | number>): T {
  const args = ['api', 'graphql', '-f', `query=${query}`]
  for (const [key, value] of Object.entries(vars)) args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`)
  const out: unknown = JSON.parse(gh(repo, args))
  if (!out || typeof out !== 'object' || !('data' in out) || !out.data) {
    throw new Error(`graphql: ${JSON.stringify(out).slice(0, 500)}`)
  }
  if ('errors' in out && Array.isArray(out.errors) && out.errors.length) {
    throw new Error(`graphql: ${JSON.stringify(out.errors).slice(0, 500)}`)
  }
  // The query text fixes the shape of `data`; a missing field fails where it is read.
  return out.data as T
}

function comment(repo: string, issue: number, body: string): void {
  gh(repo, ['issue', 'comment', String(issue), '--body-file', '-'], body)
}

// ── GitHub shapes selected below ─────────────────────────────────────────────

type Login = { login: string } | null
type RawComment = { body: string | null; author: Login }
type RawPr = {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  baseRefName: string
  headRefName: string
  headRefOid: string
  mergedAt: string | null
  mergeCommit: { oid: string; parents: { nodes: { oid: string }[] } } | null
  autoMergeRequest: { enabledAt: string } | null
  labels: { nodes: { name: string }[] }
  repository: { nameWithOwner: string }
}
type RawChild = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  body: string | null
  author: Login
  repository: { nameWithOwner: string }
  labels: { nodes: { name: string }[] }
  blockedBy: { nodes: { number: number; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[] }
  comments: { nodes: RawComment[] }
  closedByPullRequestsReferences: { nodes: RawPr[] }
  timelineItems: { nodes: ({ source?: Partial<RawPr> | null } | null)[] }
}
type EpicData = {
  viewer: { login: string }
  repository: {
    issue: {
      comments: { nodes: RawComment[] }
      subIssues: { pageInfo: { hasNextPage: boolean }; nodes: RawChild[] }
    } | null
  }
}
type RollupNode =
  | {
      __typename: 'CheckRun'
      name: string
      status: string | null
      conclusion: string | null
      startedAt: string | null
      checkSuite: { workflowRun: { workflow: { name: string } } | null } | null
    }
  | { __typename: 'StatusContext'; context: string; state: string }
type RollupData = {
  repository: { object: { statusCheckRollup: { contexts: { nodes: RollupNode[] } } | null } | null }
}
type ReviewState = {
  rounds: { reviews: number; fixes: number } | null
  lastVerdict: 'green' | 'red' | null
  reviewStop: boolean
}

const PR_FIELDS = `number state baseRefName headRefName headRefOid mergedAt
  mergeCommit { oid parents(first: 1) { nodes { oid } } }
  autoMergeRequest { enabledAt } labels(first: 30) { nodes { name } } repository { nameWithOwner }`

const EPIC_QUERY = `query($owner: String!, $name: String!, $epic: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    issue(number: $epic) {
      comments(last: 100) { nodes { body author { login } } }
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          number title state body author { login } repository { nameWithOwner }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
          comments(last: 100) { nodes { body author { login } } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
            nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } } }
          }
        }
      }
    }
  }
}`

function isPr(source: Partial<RawPr> | null | undefined): source is RawPr {
  return typeof source?.number === 'number' && typeof source.headRefName === 'string'
}

/** Bodies of this account's comments: the only surface a marker is read from. */
function ours(comments: RawComment[], viewer: string): string[] {
  return comments.filter((c) => c.author?.login === viewer).map((c) => c.body ?? '')
}

// ── Facts ────────────────────────────────────────────────────────────────────

function repoName(repo: string): { owner: string; name: string; full: string } {
  const full = gh(repo, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Error(`cannot read the repository name: ${full}`)
  return { owner, name, full }
}

/** Rounds, latest verdict and the #637 stop marker, from this account's PR comments. */
function reviewStates(repo: string, owner: string, name: string, viewer: string, numbers: number[]) {
  const out = new Map<number, ReviewState>()
  if (!numbers.length) return out
  const fields = numbers
    .map((n) => `p${n}: pullRequest(number: ${n}) { comments(last: 100) { nodes { body author { login } } } }`)
    .join('\n')
  const data = graphql<{ repository: Record<string, { comments: { nodes: RawComment[] } }> }>(
    repo,
    `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
    { owner, name },
  )
  for (const n of numbers) {
    const bodies = ours(data.repository[`p${n}`]?.comments.nodes ?? [], viewer)
    const counts = bodies.filter((body) => /^<!--\s*omp-build:review-rounds\s/.test(body))
    const record = bodies.filter((body) => /^<!--\s*omp-build:code-review\s*-->/.test(body)).at(-1) ?? ''
    const verdict = /\*\*Verdict:\s*([^*]+)\*\*/.exec(record)?.[1]?.trim() ?? ''
    out.set(n, {
      rounds: parseReviewRounds(counts.map((body) => body.split('\n', 1)[0]).join('\n')),
      lastVerdict: /^request changes/i.test(verdict) ? 'red' : /^approve/i.test(verdict) ? 'green' : null,
      reviewStop: counts.some((body) =>
        body.split('\n').some((line) => /^<!--\s*omp-build:review-stop\s+reason=[a-z0-9-]+\s*-->$/.test(line.trim())),
      ),
    })
  }
  return out
}

function prFacts(raw: RawPr, review: Map<number, ReviewState>): PrFacts {
  const labels = raw.labels.nodes.map((label) => label.name)
  const state = review.get(raw.number)
  return {
    number: raw.number,
    state: raw.state,
    base: raw.baseRefName,
    head: raw.headRefName,
    headSha: raw.headRefOid,
    mergedAt: raw.mergedAt,
    mergeSha: raw.mergeCommit?.oid ?? null,
    baseSha: raw.mergeCommit?.parents.nodes[0]?.oid ?? null,
    armed: labels.includes('reviewed') || raw.autoMergeRequest !== null,
    exhausted: state ? reviewExhausted(state, MAX_FIX_ROUNDS) : false,
  }
}

function tree(repo: string): Facts['tree'] {
  return {
    clean: git(repo, ['status', '--porcelain']) === '',
    branch: git(repo, ['branch', '--show-current']) || null,
  }
}

/** Local and origin branches claiming each child, deduped by name, with their foreign commits. */
function branchRefs(repo: string, base: string, children: number[]): Map<number, BranchFacts[]> {
  const here = realpathSync(git(repo, ['rev-parse', '--show-toplevel']))
  const checkedOut = new Map<string, string>()
  let path = ''
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice('worktree '.length)
    else if (line.startsWith('branch refs/heads/')) checkedOut.set(line.slice('branch refs/heads/'.length), path)
  }
  const byName = new Map<string, { local: string | null; remote: string | null }>()
  const refs = git(repo, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes/origin'])
  for (const line of refs.split('\n')) {
    const [ref, sha] = line.split('\t')
    if (!ref || !sha) continue
    const name = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, '')
    const ticket = ticketOfBranch(name)
    if (ticket === null || !children.includes(ticket)) continue
    const entry = byName.get(name) ?? { local: null, remote: null }
    if (ref.startsWith('refs/heads/')) entry.local = sha
    else entry.remote = sha
    byName.set(name, entry)
  }
  const out = new Map<number, BranchFacts[]>()
  for (const [name, { local, remote }] of byName) {
    const ticket = ticketOfBranch(name) ?? 0
    const tip = local ?? remote ?? ''
    const commits = git(repo, ['log', '--no-merges', '--format=%H%x09%s', `refs/remotes/origin/${base}..${tip}`])
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('\t')
        return { sha: line.slice(0, at), ticket: ticketOfSubject(line.slice(at + 1)) }
      })
    const verdict = refuseForeignCommits(commits, ticket)
    const holder = checkedOut.get(name)
    out.set(ticket, [
      ...(out.get(ticket) ?? []),
      {
        name,
        local: local !== null,
        tip,
        foreign: 'error' in verdict ? verdict.error.replace(/^foreign commit /, '') : null,
        // A branch held by a worktree whose directory is gone is still checked out there.
        elsewhere: holder && (!existsSync(holder) || realpathSync(holder) !== here) ? holder : null,
      },
    ])
  }
  return out
}

/**
 * The base HEAD's checks, filtered like `/ci-watch` filters a PR: the declared
 * `landing.required_checks`, or every check. Re-runs collapse to the newest.
 * Only failure / timed_out / startup_failure is red; pending or none proceeds.
 */
function baseCi(repo: string, owner: string, name: string, sha: string): BaseCi {
  const data = graphql<RollupData>(
    repo,
    `query($owner: String!, $name: String!, $sha: GitObjectID!) { repository(owner: $owner, name: $name) {
      object(oid: $sha) { ... on Commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
        ... on StatusContext { context state }
      } } } } } } }`,
    { owner, name, sha },
  )
  const latest = new Map<string, { name: string; status: string; conclusion: string; rank: string }>()
  for (const node of data.repository.object?.statusCheckRollup?.contexts.nodes ?? []) {
    const state = node.__typename === 'StatusContext' ? node.state.toLowerCase() : ''
    const check =
      node.__typename === 'CheckRun'
        ? {
            key: `${node.checkSuite?.workflowRun?.workflow.name ?? ''}/${node.name}`,
            name: node.name,
            status: (node.status ?? '').toLowerCase(),
            conclusion: (node.conclusion ?? '').toLowerCase(),
            started: node.startedAt ?? '',
          }
        : {
            key: `/${node.context}`,
            name: node.context,
            status: state === 'pending' || state === 'expected' ? 'in_progress' : 'completed',
            conclusion: state === 'error' ? 'failure' : state,
            started: '',
          }
    // Same ranking as ci-watch: completed before pending, then the newest start.
    const rank = `${check.status === 'completed' ? 0 : 1}${check.started}`
    const seen = latest.get(check.key)
    if (!seen || rank >= seen.rank) latest.set(check.key, { ...check, rank })
  }
  const required: string[] = readLanding(repo).required_checks
  const checks = [...latest.values()].filter((check) => !required.length || required.includes(check.name))
  const failed = checks
    .filter((c) => c.conclusion === 'failure' || c.conclusion === 'timed_out' || c.conclusion === 'startup_failure')
    .map((c) => c.name)
  const pending = checks
    .filter((c) => !failed.includes(c.name))
    .filter((c) => c.status !== 'completed' || !['success', 'skipped', 'neutral'].includes(c.conclusion))
    .map((c) => (c.status === 'completed' ? `${c.name}=${c.conclusion}` : c.name))
  const state = failed.length ? 'red' : !checks.length ? 'none' : pending.length ? 'pending' : 'green'
  return { state, failed, pending }
}

type Gathered = { facts: Facts; epicComments: string[] }

/**
 * Everything `nextStep` reads. `git: false` leaves the worktree out (for
 * `objective`, which may run anywhere); `run` and `base` come from the gate.
 */
function gather(repo: string, epic: number, run: string, base: string, { git: withGit = true } = {}): Gathered {
  const { owner, name, full } = repoName(repo)
  const data = graphql<EpicData>(repo, EPIC_QUERY, { owner, name, epic })
  const viewer = data.viewer.login
  const issue = data.repository.issue
  if (!issue) throw new Refused(`#${epic} does not exist in ${full}`)
  if (issue.subIssues.pageInfo.hasNextPage) throw new Refused(`#${epic} has more than 100 sub-issues`)
  const nodes = issue.subIssues.nodes
  const elsewhere = nodes.filter((node) => node.repository.nameWithOwner !== full)
  if (elsewhere.length) {
    const names = elsewhere.map((node) => `${node.repository.nameWithOwner}#${node.number}`).join(', ')
    throw new Refused(`the goal delivers only ${full}; sub-issues elsewhere: ${names}`)
  }

  const rawPrs = new Map<number, RawPr[]>()
  for (const node of nodes) {
    const found = new Map<number, RawPr>()
    const sources = [
      ...node.closedByPullRequestsReferences.nodes,
      ...node.timelineItems.nodes.map((item) => item?.source),
    ]
    for (const pr of sources) {
      if (isPr(pr) && pr.repository.nameWithOwner === full && ticketOfBranch(pr.headRefName) === node.number) {
        found.set(pr.number, pr)
      }
    }
    rawPrs.set(node.number, [...found.values()])
  }
  const open = [
    ...new Set(
      [...rawPrs.values()]
        .flat()
        .filter((pr) => pr.state === 'OPEN')
        .map((pr) => pr.number),
    ),
  ]
  const review = reviewStates(repo, owner, name, viewer, open)
  const numbers = nodes.map((node) => node.number)
  const refs = withGit ? branchRefs(repo, base, numbers) : new Map<number, BranchFacts[]>()

  const children: ChildFacts[] = nodes.map((node) => ({
    number: node.number,
    title: node.title,
    state: node.state,
    labels: node.labels.nodes.map((label) => label.name),
    body: node.body ?? '',
    epicFix: node.author?.login === viewer && readMarker(node.body ?? '', 'epic-fix') !== null,
    blockedBy: node.blockedBy.nodes.map((b) =>
      b.repository.nameWithOwner === full
        ? { number: b.number, state: b.state }
        : { number: b.number, state: b.state, repo: b.repository.nameWithOwner },
    ),
    stops: ours(node.comments.nodes, viewer)
      .map(parseGoalStop)
      .filter((stop) => stop !== null),
    prs: (rawPrs.get(node.number) ?? []).map((pr) => prFacts(pr, review)),
    branches: refs.get(node.number) ?? [],
  }))

  const epicComments = ours(issue.comments.nodes, viewer)
  const baseSha = withGit ? git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) : ''
  const facts: Facts = {
    epic,
    run,
    base,
    baseSha,
    tree: withGit ? tree(repo) : { clean: true, branch: null },
    baseCi: withGit ? baseCi(repo, owner, name, baseSha) : { state: 'none', failed: [], pending: [] },
    children,
    reviews: epicComments.map(parseEpicReview).filter((entry) => entry !== null),
    hooks: epicComments.map(parsePostMerge).filter((entry) => entry !== null),
  }
  return { facts, epicComments }
}

// ── Gate and location ─────────────────────────────────────────────────────────

function refusePrincipal(repo: string): void {
  const first = /^worktree (.+)$/m.exec(git(repo, ['worktree', 'list', '--porcelain']))?.[1]
  const here = realpathSync(git(repo, ['rev-parse', '--show-toplevel']))
  if (!first || (existsSync(first) && realpathSync(first) === here)) {
    throw new Refused(`${here} is the Principal; the goal runs in the epic worktree`)
  }
}

// ── GitHub writes ─────────────────────────────────────────────────────────────

function prState(repo: string, pr: number): { state: string; labels: string[]; autoMerge: boolean } {
  const view: unknown = JSON.parse(gh(repo, ['pr', 'view', String(pr), '--json', 'state,labels,autoMergeRequest']))
  if (!view || typeof view !== 'object' || !('state' in view) || !('labels' in view) || !Array.isArray(view.labels)) {
    throw new Error(`gh pr view ${pr}: unexpected ${JSON.stringify(view).slice(0, 200)}`)
  }
  return {
    state: String(view.state),
    labels: view.labels.map((label: { name?: unknown }) => String(label?.name ?? '')),
    autoMerge: 'autoMergeRequest' in view && view.autoMergeRequest !== null,
  }
}

type Disarm = 'merged' | 'closed' | 'disarmed' | 'unarmed'

/**
 * No stopped ticket stays armed: remove `reviewed`, disable native auto-merge
 * (`disarmReviewedBeforePush`, no push), read back. `merged` when the PR landed first.
 */
async function disarm(repo: string, pr: number): Promise<Disarm> {
  const before = prState(repo, pr)
  if (before.state === 'MERGED') return 'merged'
  if (before.state !== 'OPEN') return 'closed'
  const labelled = before.labels.includes('reviewed')
  if (before.autoMerge)
    await disarmReviewedBeforePush(repo, pr, { gh: async (cwd: string, args: string[]) => gh(cwd, args) })
  else if (labelled) gh(repo, ['pr', 'edit', String(pr), '--remove-label', 'reviewed'])
  const after = prState(repo, pr)
  if (after.state === 'MERGED') return 'merged'
  if (after.labels.includes('reviewed') || after.autoMerge) throw new Error(`PR #${pr} is still armed after the disarm`)
  return labelled || before.autoMerge ? 'disarmed' : 'unarmed'
}

function recordStop(repo: string, run: string, ticket: number, reason: string, detail: string): void {
  comment(
    repo,
    ticket,
    [
      formatMarker('goal-stop', { run, reason }),
      `**Goal run \`${run}\` — ticket stop \`${reason}\`.** ${detail}`,
      '',
      STICKY_STOPS.includes(reason)
        ? 'The review bound is spent: this child stays stopped in every later run until a human resolves it.'
        : 'Its dependents are skipped in this run; independent children continue. A new `/goal` line retries it.',
    ].join('\n'),
  )
}

/**
 * The one way a ticket stops, whoever proved it: disarm every open PR of the
 * child, detach HEAD from its branch (kept), then write the `goal-stop` marker.
 * A PR that merged before its disarm is no stop: `merged` names it, no marker.
 */
async function ticketStop(
  repo: string,
  run: string,
  base: string,
  child: ChildFacts,
  reason: string,
  detail: string,
): Promise<{ merged: number | null; disarmed: Record<number, Disarm> }> {
  const disarmed: Record<number, Disarm> = {}
  for (const pr of child.prs.filter((p) => p.state === 'OPEN')) {
    disarmed[pr.number] = await disarm(repo, pr.number)
    if (disarmed[pr.number] === 'merged') return { merged: pr.number, disarmed }
  }
  const here = tree(repo)
  if (here.clean && ticketOfBranch(here.branch) === child.number) {
    git(repo, ['switch', '--detach', `refs/remotes/origin/${base}`])
  }
  recordStop(repo, run, child.number, reason, detail)
  return { merged: null, disarmed }
}

// ── Subcommands ───────────────────────────────────────────────────────────────

function releaseBase(repo: string): string {
  const path = join(repo, '.dev', 'stack.yml')
  if (!existsSync(path)) throw new Refused('.dev/stack.yml is missing: no release.model to derive the base from')
  const doc: unknown = Bun.YAML.parse(readFileSync(path, 'utf8'))
  const release = doc && typeof doc === 'object' && 'release' in doc ? doc.release : null
  const model = release && typeof release === 'object' && 'model' in release ? release.model : null
  if (model === 'staging-train') return 'staging'
  if (model !== 'trunk') throw new Refused(`release.model is ${JSON.stringify(model)}, not trunk or staging-train`)
  try {
    return git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
  } catch {
    return gh(repo, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
  }
}

function objective(repo: string, epic: number): string {
  const base = releaseBase(repo)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const run = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => alphabet[byte % 36]).join('')
  const { facts } = gather(repo, epic, run, base, { git: false })
  const result = generateObjective({ epic, run, base, children: facts.children })
  if ('error' in result) {
    const unscoped = facts.children.filter((c) => c.state === 'OPEN' && !hasScope(c)).map((c) => `#${c.number}`)
    throw new Refused(
      `objective=refused ${result.error}${unscoped.length ? ` — frame ${unscoped.join(', ')} (§4)` : ''}`,
    )
  }
  return [
    `/goal ${result.objective}`,
    '',
    `order: ${result.order.map((n) => `#${n}`).join(' → ') || '(no open child)'}`,
    ...result.blocked.map(
      ({ ticket, blockers }) => `blocked: #${ticket} by ${blockers.map((b) => `#${b}`).join(', ')}`,
    ),
  ].join('\n')
}

type NextOut = {
  run: string
  base: string
  step: Step
  recorded: { ticket: number; stop: string; disarmed?: Record<number, Disarm> }[]
  cleaned: string[]
  disarmed: Disarm | null
}

async function next(repo: string, epic: number, run: string, base: string, dry: boolean): Promise<NextOut> {
  if (!dry) {
    refusePrincipal(repo)
    git(repo, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
  }
  let landing: string | null = null
  try {
    readLanding(repo)
  } catch (error) {
    landing = error instanceof Error ? error.message : String(error)
  }
  if (landing) {
    const report: Report = summarize(gather(repo, epic, run, base, { git: false }).facts)
    const step: Step = { action: 'drop', stop: 'bad-landing', reason: landing, report }
    return { run, base, step, recorded: [], cleaned: [], disarmed: null }
  }

  let { facts } = gather(repo, epic, run, base)
  // Confirm and clean each merged child: MERGED into the base, from a branch
  // claiming it, whose local tip is exactly the merged head.
  const cleaned: string[] = []
  const merged = mergedLocalBranches(facts)
  if (dry) cleaned.push(...merged.map((entry) => `${entry.branch} (would delete)`))
  else if (merged.length) {
    if (facts.tree.clean && merged.some((entry) => entry.branch === facts.tree.branch)) {
      git(repo, ['switch', '--detach', `refs/remotes/origin/${base}`])
    }
    const head = git(repo, ['branch', '--show-current'])
    for (const { branch } of merged.filter((entry) => entry.branch !== head)) {
      git(repo, ['branch', '-D', branch])
      cleaned.push(branch)
    }
    facts = gather(repo, epic, run, base).facts
  }

  const recorded: { ticket: number; stop: string; disarmed?: Record<number, Disarm> }[] = []
  const handled = new Set<number>()
  let step = nextStep(facts)
  while (step.action === 'stop') {
    const { ticket, stop, reason } = step
    if (handled.has(ticket)) throw new Error(`#${ticket} came back as a stop twice in one call`)
    handled.add(ticket)
    const child = facts.children.find((c) => c.number === ticket) as ChildFacts
    if (dry) {
      recorded.push({ ticket, stop })
      child.stops.push({ run, reason: stop })
    } else {
      const outcome = await ticketStop(repo, run, base, child, stop, reason)
      if (outcome.merged === null) {
        recorded.push({ ticket, stop, disarmed: outcome.disarmed })
        child.stops.push({ run, reason: stop })
        facts.tree = tree(repo)
      } else facts = gather(repo, epic, run, base).facts
    }
    step = nextStep(facts)
  }

  let disarmed: Disarm | null = null
  if (!dry && (step.action === 'start' || step.action === 'resume')) {
    const { ticket, branch } = step
    if (step.action === 'start') git(repo, ['switch', '-c', branch, `refs/remotes/origin/${base}`])
    else if (git(repo, ['branch', '--show-current']) !== branch) {
      const local = facts.children.find((c) => c.number === ticket)?.branches.find((b) => b.name === branch)?.local
      git(repo, local ? ['switch', branch] : ['switch', '-c', branch, '--track', `refs/remotes/origin/${branch}`])
    }
    const landed = git(repo, ['branch', '--show-current'])
    const claim = resolveTicketBranch(
      landed,
      facts.children.map((child) => child.number),
    )
    if (landed !== branch || 'error' in claim || claim.ticket !== ticket) {
      throw new Error(`after the switch HEAD is ${landed || 'detached'}, not ${branch}`)
    }
    if (step.action === 'resume' && step.pr?.armed) {
      disarmed = await disarm(repo, step.pr.number)
      if (disarmed === 'merged') return next(repo, epic, run, base, dry)
    }
  }
  return { run, base, step, recorded, cleaned, disarmed }
}

async function stop(
  repo: string,
  epic: number,
  run: string,
  base: string,
  ticket: number,
  reason: string,
  detail: string,
): Promise<Record<string, unknown>> {
  if (stopClass(reason) !== 'ticket') throw new Refused(`${reason} is not a ticket stop: ${TICKET_STOPS.join(', ')}`)
  refusePrincipal(repo)
  if (git(repo, ['status', '--porcelain']) !== '') {
    throw new Error(`the tree is dirty: commit #${ticket}'s work on its branch, subject ending (#${ticket}), first`)
  }
  const { facts } = gather(repo, epic, run, base)
  const child = facts.children.find((c) => c.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  const outcome = await ticketStop(repo, run, base, child, reason, detail)
  if (outcome.merged !== null) return { ticket, merged: outcome.merged, disarmed: outcome.disarmed }
  return { ticket, stop: reason, sticky: STICKY_STOPS.includes(reason), disarmed: outcome.disarmed }
}

function review(repo: string, epic: number, run: string, base: string, verdict: string, range: string, detail: string) {
  if (verdict !== 'clean' && verdict !== 'blocking')
    throw new Refused(`--verdict must be clean or blocking: ${verdict}`)
  refusePrincipal(repo)
  const step = nextStep(gather(repo, epic, run, base).facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || step.range !== range) {
    throw new Refused(`the driver expects no final review of ${range} (next: ${step.action})`)
  }
  const head = formatMarker('epic-review', { run, verdict, range })
  comment(repo, epic, [head, `**Final epic review: ${verdict}** on \`${range}\`.`, '', detail].join('\n'))
  return { verdict, range }
}

async function hook(repo: string, epic: number, run: string, base: string): Promise<HookResult> {
  refusePrincipal(repo)
  const { facts } = gather(repo, epic, run, base)
  const step = nextStep(facts)
  if (step.action !== 'post-merge') throw new Refused(`the driver expects no post-merge hook (next: ${step.action})`)
  const mark = (result: string, sha: string, text: string) =>
    comment(repo, epic, `${formatMarker('post-merge', { run, result, sha })}\n${text}`)
  let outcome: HookResult
  try {
    outcome = await runPostMergeHook(repo, base, {
      onStart: (sha, argv) =>
        mark('started', sha, `Post-merge hook started at \`${sha}\`: \`${JSON.stringify(argv)}\`.`),
    })
  } catch (error) {
    outcome = { result: 'failed', sha: null, detail: error instanceof Error ? error.message : String(error) }
  }
  const sha = outcome.sha ?? facts.baseSha
  const tail = outcome.output ? `\n\n\`\`\`\n${outcome.output.slice(-3000)}\n\`\`\`` : ''
  mark(outcome.result, sha, `Post-merge hook **${outcome.result}** at \`${sha}\`: ${outcome.detail}${tail}`)
  return outcome
}

async function report(repo: string, epic: number, run: string, base: string, outcome: string, reason: string) {
  if (outcome !== 'complete' && outcome !== 'drop') throw new Refused(`--outcome must be complete or drop: ${outcome}`)
  refusePrincipal(repo)
  let { facts, epicComments } = gather(repo, epic, run, base)
  const disarmed: Record<number, Disarm> = {}
  if (outcome === 'complete') {
    const step = nextStep(facts)
    if (step.action !== 'complete') throw new Refused(`the goal is not complete (next: ${step.action})`)
  } else {
    for (const pr of facts.children.flatMap((child) => child.prs).filter((p) => p.state === 'OPEN' && p.armed)) {
      disarmed[pr.number] = await disarm(repo, pr.number)
    }
    if (Object.keys(disarmed).length) ({ facts, epicComments } = gather(repo, epic, run, base))
  }
  const summary = summarize(facts)
  const hookRun = facts.hooks.filter((h) => h.run === run).at(-1)
  const list = (items: number[]) => (items.length ? items.map((n) => `#${n}`).join(', ') : '—')
  const text = [
    formatMarker('goal-report', { run }),
    `## Goal run \`${run}\` — ${outcome === 'complete' ? 'complete' : `dropped: \`${reason || 'unspecified'}\``}`,
    '',
    '| | |',
    '|---|---|',
    `| Merged into \`${base}\` | ${list(summary.merged)} |`,
    `| Closed without a merged PR | ${list(summary.closed)} |`,
    `| Stopped | ${summary.stopped.map((s) => `#${s.ticket} \`${s.reason}\`${s.sticky ? ' (sticky)' : ''}`).join(', ') || '—'} |`,
    `| Skipped (open blocker) | ${summary.skipped.map((s) => `#${s.ticket} by ${list(s.blockers)}`).join(', ') || '—'} |`,
    `| Post-merge hook | ${hookRun ? `${hookRun.result} at \`${hookRun.sha}\`` : 'not run'} |`,
    `| Base CI | ${summary.baseCi.state}${summary.baseCi.failed.length ? ` (failed: ${summary.baseCi.failed.join(', ')})` : ''} |`,
    ...(Object.keys(disarmed).length
      ? [
          `| Disarmed | ${Object.entries(disarmed)
            .map(([pr, what]) => `#${pr} ${what}`)
            .join(', ')} |`,
        ]
      : []),
  ].join('\n')
  const posted = !epicComments.some((body) => readMarker(body, 'goal-report')?.run === run)
  if (posted) comment(repo, epic, text)
  return { posted, text }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(argv: string[]): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      epic: { type: 'string' },
      repo: { type: 'string' },
      'goal-status': { type: 'string' },
      'goal-objective': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ticket: { type: 'string' },
      reason: { type: 'string', default: '' },
      detail: { type: 'string', default: '' },
      verdict: { type: 'string', default: '' },
      range: { type: 'string', default: '' },
      outcome: { type: 'string', default: '' },
    },
  })
  const [command] = positionals
  const repo = realpathSync(values.repo ?? process.cwd())
  const epic = Number((values.epic ?? '').replace(/^#/, ''))
  if (!Number.isInteger(epic) || epic <= 0) throw new Refused('--epic <N> is required')
  if (command === 'objective') return objective(repo, epic)

  const authorized = goalRun({ status: values['goal-status'], objective: values['goal-objective'] }, epic)
  if (!authorized) {
    throw new Assisted(
      `no active goal names /feature #${epic} with one run= and one base= (status ${values['goal-status'] ?? 'none'})`,
    )
  }
  const { run, base } = authorized
  const ticket = Number((values.ticket ?? '').replace(/^#/, ''))
  switch (command) {
    case 'next':
      return JSON.stringify(await next(repo, epic, run, base, values['dry-run'] ?? false), null, 2)
    case 'stop':
      return JSON.stringify(await stop(repo, epic, run, base, ticket, values.reason, values.detail), null, 2)
    case 'review':
      return JSON.stringify(review(repo, epic, run, base, values.verdict, values.range, values.detail), null, 2)
    case 'hook': {
      const outcome = await hook(repo, epic, run, base)
      if (outcome.result === 'failed') throw new Error(`hook-failed ${JSON.stringify(outcome)}`)
      return JSON.stringify(outcome, null, 2)
    }
    case 'report':
      return (await report(repo, epic, run, base, values.outcome, values.reason)).text
    default:
      throw new Refused(`unknown subcommand ${command ?? '(none)'}: objective | next | stop | review | hook | report`)
  }
}

if (import.meta.main) {
  try {
    console.log(await main(process.argv.slice(2)))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const [code, tag] =
      error instanceof Assisted ? [3, 'assisted'] : error instanceof Refused ? [2, 'refused'] : [1, 'failed']
    console.error(`driver=${tag} ${message}`)
    process.exit(code)
  }
}
