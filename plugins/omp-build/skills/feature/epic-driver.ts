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
 *   stop      --epic E <gate> --ticket N --reason R [--detail-file F]     record a ticket stop (disarms first)
 *   review    --epic E <gate> --verdict V --range A..B [--detail-file F]  record the final epic review
 *   hook      --epic E <gate> --repo <worktree>         run release.post_merge (cwd outside the repo)
 *   report    --epic E <gate> --outcome complete|drop   post the goal report (drop disarms every PR)
 *
 * <gate> is `--goal-status <status> --goal-objective-file <file>` from
 * `goal({op:"get"})`: nothing but `objective` runs unless the goal is active and
 * names the epic; the run id and the base come from that objective. Free text
 * (objective, detail) is read from a file, `-` for stdin — never an argv word.
 * Exit: 0 done · 1 failed (shared-state stop) · 2 refused · 3 assisted (no gate).
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  armedStoppedPrs,
  type BaseCi,
  type BranchFacts,
  baseFromStack,
  type CheckNode,
  type ChildFacts,
  classifyBaseCi,
  type Facts,
  formatMarker,
  generateObjective,
  goalRun,
  hookStatus,
  mergedLocalBranches,
  mergedStoppedPrs,
  nextStep,
  type PrFacts,
  parseEpicReview,
  parseGoalStop,
  parsePostMerge,
  readMarker,
  refuseForeignCommits,
  resolveTicketBranch,
  STICKY_STOPS,
  type Step,
  stopClass,
  summarize,
  TICKET_STOPS,
  ticketOfBranch,
  ticketOfSubject,
} from './epic'
import { type HookResult, runPostMergeHook } from './epic-close'
import { disarmReviewedBeforePush, interpretReviewHistory, readLanding } from './workflow.js'

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
  /** A fork PR: its head lives outside this repository, so no local ref proves what it lands. */
  isCrossRepository: boolean
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
type RollupData = {
  repository: { object: { statusCheckRollup: { contexts: { nodes: CheckNode[] } } | null } | null }
}

const PR_FIELDS = `number state baseRefName headRefName headRefOid mergedAt isCrossRepository
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

/**
 * The PRs whose review loop has stopped, per `interpretReviewHistory` — the one
 * reading of a PR's review records (#637) that `landPr` and `resumeReviewLoop`
 * also use. `comments(last: 100)` in creation order, as that reader expects.
 */
function stoppedReviews(repo: string, owner: string, name: string, viewer: string, numbers: number[]): Set<number> {
  const out = new Set<number>()
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
    const nodes = data.repository[`p${n}`]?.comments.nodes ?? []
    const history = nodes.map((c) => ({ body: c.body ?? '', author: c.author }))
    if (interpretReviewHistory(history, { me: viewer }).stopReason) out.add(n)
  }
  return out
}

function prFacts(raw: RawPr, stopped: Set<number>): PrFacts {
  const labels = raw.labels.nodes.map((label) => label.name)
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
    exhausted: stopped.has(raw.number),
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
    // Both tips are checked: the local one is what gets pushed, the origin one is what a PR lands.
    const commits = [...new Set([local, remote].filter((sha) => sha !== null))].flatMap((sha) =>
      git(repo, ['log', '--no-merges', '--format=%H%x09%s', `refs/remotes/origin/${base}..${sha}`])
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf('\t')
          return { sha: line.slice(0, at), ticket: ticketOfSubject(line.slice(at + 1)) }
        }),
    )
    const verdict = refuseForeignCommits(commits, ticket)
    const holder = checkedOut.get(name)
    out.set(ticket, [
      ...(out.get(ticket) ?? []),
      {
        name,
        local: local !== null,
        tip: local ?? remote ?? '',
        remoteTip: remote,
        foreign: 'error' in verdict ? verdict.error.replace(/^foreign commit /, '') : null,
        // A branch held by a worktree whose directory is gone is still checked out there.
        elsewhere: holder && (!existsSync(holder) || realpathSync(holder) !== here) ? holder : null,
      },
    ])
  }
  return out
}

/** The base HEAD's check rollup, reduced by `classifyBaseCi` with the landing's check set. */
function baseCi(repo: string, owner: string, name: string, sha: string, required: string[]): BaseCi {
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
  return classifyBaseCi(data.repository.object?.statusCheckRollup?.contexts.nodes ?? [], required)
}

type Gathered = { facts: Facts; epicComments: string[] }

/**
 * Everything `nextStep` reads. `git: false` leaves the worktree out (for
 * `objective`, which may run anywhere); `run` and `base` come from the gate.
 */
function gather(
  repo: string,
  epic: number,
  run: string,
  base: string,
  { git: withGit = true, dashboard = true, reviews = true } = {},
): Gathered {
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
      const same = isPr(pr) && pr.repository.nameWithOwner === full && !pr.isCrossRepository
      if (same && ticketOfBranch(pr.headRefName) === node.number) {
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
  const stopped = reviews ? stoppedReviews(repo, owner, name, viewer, open) : new Set<number>()
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
    prs: (rawPrs.get(node.number) ?? []).map((pr) => prFacts(pr, stopped)),
    branches: refs.get(node.number) ?? [],
  }))

  const epicComments = ours(issue.comments.nodes, viewer)
  const baseSha = withGit ? git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) : ''
  // An unreadable landing is a fact, not a throw: the drop it causes must still disarm and report.
  // A drop reads children and PRs first (`dashboard: false`) and does not touch landing or base CI.
  let landing: { required_checks: string[] } | null = null
  let landingError: string | null = null
  if (dashboard) {
    try {
      landing = readLanding(repo)
    } catch (error) {
      landingError = error instanceof Error ? error.message : String(error)
    }
  }
  const facts: Facts = {
    epic,
    run,
    base,
    baseSha,
    tree: withGit ? tree(repo) : { clean: true, branch: null },
    baseCi: !dashboard
      ? { state: 'unread', failed: [], pending: [] }
      : withGit && landing
        ? baseCi(repo, owner, name, baseSha, landing.required_checks)
        : { state: 'none', failed: [], pending: [] },
    landingError,
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
  const resolved = baseFromStack(Bun.YAML.parse(readFileSync(path, 'utf8')), () => {
    try {
      return git(repo, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '')
    } catch {
      return gh(repo, ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'])
    }
  })
  if ('error' in resolved) throw new Refused(resolved.error)
  return resolved.base
}

function objective(repo: string, epic: number): string {
  const base = releaseBase(repo)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const run = [...crypto.getRandomValues(new Uint8Array(8))].map((byte) => alphabet[byte % 36]).join('')
  const { facts } = gather(repo, epic, run, base, { git: false })
  const result = generateObjective({ epic, run, base, children: facts.children })
  if ('error' in result) {
    const frame = result.missing?.length ? ` — frame ${result.missing.map((n) => `#${n}`).join(', ')} (§4)` : ''
    throw new Refused(`objective=refused ${result.error}${frame}`)
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
  reconciled: { ticket: number; pr: number; disarmed: Disarm | 'dry-run' }[]
}

async function next(repo: string, epic: number, run: string, base: string, dry: boolean, reread = 0): Promise<NextOut> {
  if (!dry) {
    refusePrincipal(repo)
    git(repo, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
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
  const reconciled: { ticket: number; pr: number; disarmed: Disarm | 'dry-run' }[] = []
  const problems: string[] = []
  for (const entry of armedStoppedPrs(facts)) {
    if (dry) {
      reconciled.push({ ticket: entry.ticket, pr: entry.pr, disarmed: 'dry-run' })
      continue
    }
    try {
      const what = await disarm(repo, entry.pr)
      reconciled.push({ ticket: entry.ticket, pr: entry.pr, disarmed: what })
      if (what === 'merged') problems.push(`PR #${entry.pr} merged before it could be disarmed`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      problems.push(`PR #${entry.pr} stayed armed: ${message}`)
    }
  }
  for (const entry of mergedStoppedPrs(facts)) problems.push(`PR #${entry.pr} already merged`)
  if (problems.length) {
    return {
      run,
      base,
      step: {
        action: 'drop',
        stop: 'driver-error',
        reason: problems.join('; '),
        report: summarize(facts),
      },
      recorded,
      cleaned,
      disarmed: null,
      reconciled,
    }
  }
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
      // The PR merged between the read and the disarm: read GitHub once more. A second
      // time means the facts still say OPEN while the PR says MERGED — stop, do not spin.
      if (disarmed === 'merged') {
        if (reread > 0) throw new Error(`PR #${step.pr.number} merged, yet the facts still show it open`)
        return next(repo, epic, run, base, dry, reread + 1)
      }
    }
  }
  return { run, base, step, recorded, cleaned, disarmed, reconciled }
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
  // Result, exit code and sha only: the hook's output can carry the session's secrets,
  // and the tracker is public. The output reaches the chat through the JSON below.
  const code = outcome.code === undefined ? '' : ` (exit ${outcome.code})`
  mark(outcome.result, sha, `Post-merge hook **${outcome.result}**${code} at \`${sha}\`.`)
  return outcome
}

async function report(
  repo: string,
  epic: number,
  run: string,
  base: string,
  outcome: string,
  reason: string,
): Promise<{ posted: boolean; text: string; stillArmed: number[] }> {
  if (outcome !== 'complete' && outcome !== 'drop') throw new Refused(`--outcome must be complete or drop: ${outcome}`)
  refusePrincipal(repo)
  const disarmed: Record<number, Disarm> = {}
  const stillArmed: number[] = []
  let facts: Facts
  let epicComments: string[]
  if (outcome === 'complete') {
    ;({ facts, epicComments } = gather(repo, epic, run, base))
    const step = nextStep(facts)
    if (step.action !== 'complete') throw new Refused(`the goal is not complete (next: ${step.action})`)
  } else {
    const light = gather(repo, epic, run, base, { git: false, dashboard: false, reviews: false })
    const armed = light.facts.children
      .flatMap((child) => child.prs)
      .filter((pr) => pr.state === 'OPEN' && pr.armed)
      .sort((a, b) => a.number - b.number)
    for (const pr of armed) {
      try {
        disarmed[pr.number] = await disarm(repo, pr.number)
      } catch {
        stillArmed.push(pr.number)
      }
    }
    try {
      ;({ facts, epicComments } = gather(repo, epic, run, base))
      if (facts.landingError) {
        facts = { ...facts, baseCi: { state: 'unread', failed: [], pending: [] } }
      }
    } catch {
      facts = { ...light.facts, baseCi: { state: 'unread', failed: [], pending: [] } }
      epicComments = light.epicComments
    }
  }
  const summary = summarize(facts)
  const hook = hookStatus(facts).record
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
    `| Post-merge hook | ${hook ? `${hook.result} at \`${hook.sha}\`${hook.run === run ? '' : ` (run \`${hook.run}\`)`}` : 'not run'} |`,
    `| Base CI | ${summary.baseCi.state}${summary.baseCi.failed.length ? ` (failed: ${summary.baseCi.failed.join(', ')})` : ''} |`,
    ...(Object.keys(disarmed).length
      ? [
          `| Disarmed | ${Object.entries(disarmed)
            .map(([pr, what]) => `#${pr} ${what}`)
            .join(', ')} |`,
        ]
      : []),
    ...(stillArmed.length ? [`| Still armed | ${list(stillArmed)} |`] : []),
  ].join('\n')
  const posted = !epicComments.some((body) => readMarker(body, 'goal-report')?.run === run)
  const named = stillArmed.length ? `still armed: ${stillArmed.map((pr) => `#${pr}`).join(', ')}` : ''
  if (named) {
    console.log(text)
    console.error(named)
  }
  if (posted) {
    try {
      comment(repo, epic, text)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(named ? `${named}; comment failed: ${message}` : message)
    }
  }
  if (named) throw new Error(named)
  return { posted, text, stillArmed }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Free text — the goal objective, a stop or review detail — never travels as an
 * argv word the caller had to quote: it is read from a file, or stdin for `-`.
 */
function textFile(path: string | undefined, flag: string): string {
  if (path === undefined) return ''
  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8').trim()
  } catch (error) {
    throw new Refused(`${flag} ${path}: ${error instanceof Error ? error.message : error}`)
  }
}

async function main(argv: string[]): Promise<string> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      epic: { type: 'string' },
      repo: { type: 'string' },
      'goal-status': { type: 'string' },
      'goal-objective-file': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      ticket: { type: 'string' },
      reason: { type: 'string', default: '' },
      'detail-file': { type: 'string' },
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

  const goal = {
    status: values['goal-status'],
    objective: textFile(values['goal-objective-file'], '--goal-objective-file'),
  }
  const authorized = goalRun(goal, epic)
  if (!authorized) {
    throw new Assisted(
      `no active goal names /feature #${epic} with one run= and one base= (status ${values['goal-status'] ?? 'none'})`,
    )
  }
  const { run, base } = authorized
  const ticket = Number((values.ticket ?? '').replace(/^#/, ''))
  const detail = textFile(values['detail-file'], '--detail-file')
  switch (command) {
    case 'next':
      return JSON.stringify(await next(repo, epic, run, base, values['dry-run'] ?? false), null, 2)
    case 'stop':
      return JSON.stringify(await stop(repo, epic, run, base, ticket, values.reason, detail), null, 2)
    case 'review':
      return JSON.stringify(review(repo, epic, run, base, values.verdict, values.range, detail), null, 2)
    case 'hook': {
      const outcome = await hook(repo, epic, run, base)
      if (outcome.result === 'failed') throw new Error(`hook-failed ${JSON.stringify(outcome)}`)
      return JSON.stringify(outcome, null, 2)
    }
    case 'report': {
      const out = await report(repo, epic, run, base, values.outcome, values.reason)
      if (out.stillArmed.length) {
        console.log(out.text)
        throw new Error(`still armed: ${out.stillArmed.map((pr) => `#${pr}`).join(', ')}`)
      }
      return out.text
    }
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
