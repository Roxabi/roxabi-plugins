/**
 * epic-driver — the executable half of the Epic route.
 *
 * Reads the confirmed mandate from the epic issue, gathers facts, asks `nextStep`
 * for the one next action, and performs its git transitions and canonical GitHub
 * event publication. A session calls it before every ticket and never relies on
 * memory of earlier tickets. There is no local goal gate.
 *
 *   next      --epic E [--dry-run]
 *   stop      --epic E --ticket N --reason R [--detail-file F]
 *   mark-fix  --epic E --ticket N
 *   review    --epic E --decision-record ID --range A..B
 *   hook      --epic E --repo <worktree>
 *   report    --epic E --outcome complete|drop
 *
 * Free text (a stop detail) is read from a file, `-` for stdin — never an argv word.
 * Exit: 0 done · 1 failed (shared-state stop) · 2 refused · 3 assisted (no mandate).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { parseArgs } from 'node:util'
import {
  buildRecord,
  type CanonicalRecord,
  classifyHistory,
  type DecodedHistory,
  decodeHistory,
  githubScope,
  type Json,
  publishGitHubRecord,
  readGitHubHistory,
  selectApplicableMandate,
  specDigest,
  summarizeReviews,
  validateDecision,
  validateRecordGraph,
} from '../../dist/contracts.js'
import { withRoxabiGitHubPolicy } from '../../roxabi/github-policy.ts'
import { loadReviewConfig } from '../../roxabi/review-config.ts'
import { configCompatibility } from '../../roxabi/workflow-config.ts'
import {
  armedStoppedPrs,
  BASE_NAME,
  type BaseCi,
  type BranchFacts,
  type CheckNode,
  type ChildFacts,
  classifyBaseCi,
  type EpicStepName,
  epicStepName,
  type Facts,
  frameEpic,
  hookStatus,
  mergedLocalBranches,
  mergedStoppedPrs,
  nextStep,
  type PrFacts,
  parseEpicEvent,
  RUN_ID,
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
import type { ProofConfigPin } from './proof'
import { disarmReviewedBeforePush, readLanding } from './workflow.js'

class Refused extends Error {}
class Assisted extends Error {}

// ── Process helpers ──────────────────────────────────────────────────────────

const GIT_REDIRECTS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY']

export type EpicGit = (repo: string, args: string[]) => string
export type EpicGh = (repo: string, args: string[], input?: string) => string
export type ConfigCheck = (repo: string, effective: unknown) => Promise<{ ok: true } | { ok: false; error: string }>
export type EpicEffects = { git?: EpicGit; gh?: EpicGh; configCompatible?: ConfigCheck }

const effects = new AsyncLocalStorage<EpicEffects>()

function childEnv(): NodeJS.ProcessEnv {
  const out = { ...process.env }
  for (const key of GIT_REDIRECTS) delete out[key]
  return out
}

function git(repo: string, args: string[]): string {
  const injected = effects.getStore()?.git
  if (injected) return injected(repo, args).trim()
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    env: childEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function gh(repo: string, args: string[], input?: string): string {
  const injected = effects.getStore()?.gh
  if (injected) return injected(repo, args, input).trim()
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

// ── GitHub shapes selected below ─────────────────────────────────────────────

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

function isPr(value: Partial<RawPr> | null | undefined): value is RawPr {
  return (
    value !== null &&
    value !== undefined &&
    typeof value.number === 'number' &&
    (value.state === 'OPEN' || value.state === 'CLOSED' || value.state === 'MERGED') &&
    typeof value.baseRefName === 'string' &&
    typeof value.headRefName === 'string' &&
    typeof value.headRefOid === 'string' &&
    value.repository !== undefined &&
    typeof value.repository.nameWithOwner === 'string' &&
    typeof value.isCrossRepository === 'boolean' &&
    value.labels !== undefined &&
    Array.isArray(value.labels.nodes) &&
    value.mergeCommit !== undefined &&
    value.autoMergeRequest !== undefined &&
    value.mergedAt !== undefined
  )
}
type RawChild = {
  number: number
  title: string
  state: 'OPEN' | 'CLOSED'
  body: string | null
  repository: { nameWithOwner: string }
  labels: { nodes: { name: string }[] }
  blockedBy: { nodes: { number: number; state: 'OPEN' | 'CLOSED'; repository: { nameWithOwner: string } }[] }
  closedByPullRequestsReferences: { nodes: RawPr[] }
  timelineItems: { nodes: ({ source?: Partial<RawPr> | null } | null)[] }
}
type EpicData = {
  repository: {
    issue: {
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
  repository(owner: $owner, name: $name) {
    issue(number: $epic) {
      subIssues(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          number title state body repository { nameWithOwner }
          labels(first: 50) { nodes { name } }
          blockedBy(first: 50) { nodes { number state repository { nameWithOwner } } }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) { nodes { ${PR_FIELDS} } }
          timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: 50) {
            nodes { ... on CrossReferencedEvent { source { ... on PullRequest { ${PR_FIELDS} } } } }
          }
        }
      }
    }
  }
}`

// ── Facts ────────────────────────────────────────────────────────────────────

function repoName(repo: string): { owner: string; name: string; full: string } {
  const full = gh(repo, ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'])
  const [owner, name] = full.split('/')
  if (!owner || !name) throw new Error(`cannot read the repository name: ${full}`)
  return { owner, name, full }
}

function adapterOptions(repo: string) {
  return withRoxabiGitHubPolicy({ cwd: repo, gh: async (cwd: string, args: string[]) => gh(cwd, args) })
}

async function issueHistory(repo: string, repository: string, issue: number): Promise<DecodedHistory> {
  return decodeHistory(await readGitHubHistory(githubScope(repository, issue), adapterOptions(repo)))
}

async function historyFor(repo: string, scope: { repository: string; target: string }): Promise<DecodedHistory> {
  return decodeHistory(await readGitHubHistory(scope, adapterOptions(repo)))
}

function diagnosticsText(diagnostics: readonly { code: string; message: string }[]): string {
  return diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; ')
}

/** The canonical review graph is the only source of review-bound disposition. */
async function stoppedReviews(repo: string, repository: string, numbers: number[]): Promise<Set<number>> {
  const taxonomy = loadReviewConfig().canonicalClasses
  const states = await Promise.all(
    numbers.map(async (number) => {
      const summary = summarizeReviews(await issueHistory(repo, repository, number), taxonomy, null)
      if (!summary.ok)
        throw new Refused(`PR #${number} review history is not admissible: ${diagnosticsText(summary.diagnostics)}`)
      return summary.value.spent ? number : null
    }),
  )
  return new Set(states.filter((number): number is number => number !== null))
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

type EpicEvent = { record: Extract<CanonicalRecord, { kind: 'epic-event' }>; payload: Record<string, Json> }
type Gathered = { facts: Facts; epicHistory: DecodedHistory }

function epicEvents(history: DecodedHistory): EpicEvent[] {
  const classified = classifyHistory(history)
  if (classified.authorityHistory.diagnostics.length > 0) {
    throw new Refused(
      `${history.source.scope.target} history is not admissible: ${diagnosticsText(classified.authorityHistory.diagnostics)}`,
    )
  }
  const events: EpicEvent[] = []
  for (const attribution of classified.classes) {
    const operation = history.operations[attribution.index]
    if (operation === undefined)
      throw new Refused(`${history.source.scope.target} authority attribution is out of bounds`)
    if (attribution.authority === 'foreign') continue
    if (operation.kind !== 'epic-event') continue
    if (attribution.authority !== 'accounted') {
      throw new Refused(`Epic event ${operation.operationId ?? 'unknown operation'} has ambiguous native authority`)
    }
    if (operation.status !== 'complete' || operation.record?.kind !== 'epic-event') {
      throw new Refused(
        `${history.source.scope.target} has ${operation.status} Epic event history (${operation.operationId ?? 'unknown operation'})`,
      )
    }
    const payload = operation.record.payload
    if (parseEpicEvent(payload) === null) {
      throw new Refused(`Epic event ${operation.record.recordId} has an invalid domain payload`)
    }
    events.push({ record: operation.record, payload: payload as Record<string, Json> })
  }
  return events
}

function eventText(payload: Record<string, Json>, field: string): string | null {
  const value = payload[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function eventTextArray(payload: Record<string, Json>, field: string): string[] | null {
  const value = payload[field]
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string' && entry.length > 0)
    ? (value as string[])
    : null
}

function sameReferences(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    new Set(right).size === right.length &&
    left.every((value) => right.includes(value))
  )
}

/**
 * An Epic review event points to the canonical decision graph. Its disposition
 * is derived only after the exact range, synthesis root and full inventory set
 * are independently bound through the common record core.
 */
function reviewsFromEvents(history: DecodedHistory): Facts['reviews'] {
  const events = epicEvents(history).filter(({ payload }) => payload.event === 'epic-review')
  if (events.length === 0) return []
  const authorityHistory = classifyHistory(history).authorityHistory
  const graph = validateRecordGraph(authorityHistory)
  if (!graph.ok) throw new Refused(`Epic review history is not admissible: ${diagnosticsText(graph.diagnostics)}`)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const taxonomy = loadReviewConfig().canonicalClasses
  const reviews: Facts['reviews'] = []
  for (const { record, payload } of events) {
    const run = eventText(payload, 'run')
    const range = eventText(payload, 'range')
    const decisionId = eventText(payload, 'decisionId')
    const inventoryIds = eventTextArray(payload, 'inventoryIds')
    if (run === null || range === null || decisionId === null || inventoryIds === null || record.runId !== run) {
      throw new Refused(`Epic review event ${record.recordId} has malformed references`)
    }
    const decision = records.get(decisionId)
    if (decision?.kind !== 'decision')
      throw new Refused(`Epic review event ${record.recordId} names no decision ${decisionId}`)
    const synthesis = records.get(decision.payload.originalContributionId)
    if (synthesis?.kind !== 'contribution' || synthesis.payload.inventoryId === null) {
      throw new Refused(`Epic review event ${record.recordId} decision is not bound to a synthesis inventory`)
    }
    const synthesisInventory = records.get(synthesis.payload.inventoryId)
    const root =
      synthesisInventory?.kind === 'review-attempt' ? records.get(synthesisInventory.payload.rootAttemptId) : null
    if (
      root?.kind !== 'review-attempt' ||
      root.payload.stage !== 'initial' ||
      root.payload.purpose !== 'review' ||
      root.payload.subject.kind !== 'epic-range' ||
      root.payload.subject.range !== range
    ) {
      throw new Refused(`Epic review event ${record.recordId} does not bind the exact Epic range`)
    }
    const expectedInventories = [...records.values()]
      .filter(
        (candidate): candidate is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
          candidate.kind === 'review-attempt' && candidate.payload.rootAttemptId === root.recordId,
      )
      .map((inventory) => inventory.recordId)
    if (
      !sameReferences(inventoryIds, expectedInventories) ||
      !sameReferences(record.inputs, [decisionId, ...inventoryIds])
    ) {
      throw new Refused(`Epic review event ${record.recordId} does not bind its exact decision inventories`)
    }
    const assessment = validateDecision(decision, authorityHistory, taxonomy, null)
    if (!assessment.admissible || assessment.verdict === null) {
      throw new Refused(
        `Epic review event ${record.recordId} decision is not admissible: ${diagnosticsText(assessment.diagnostics)}`,
      )
    }
    reviews.push({ run, range, verdict: assessment.verdict === 'Request changes' ? 'blocking' : 'clean' })
  }
  return reviews
}

function stopsFromEvents(history: DecodedHistory): ChildFacts['stops'] {
  const stops: ChildFacts['stops'] = []
  for (const { record, payload } of epicEvents(history)) {
    if (payload.event !== 'goal-stop') continue
    const run = eventText(payload, 'run')
    const reason = eventText(payload, 'reason')
    if (run !== null && reason !== null && record.runId === run) stops.push({ run, reason })
  }
  return stops
}

function hooksFromEvents(history: DecodedHistory): Facts['hooks'] {
  const hooks: Facts['hooks'] = []
  for (const { record, payload } of epicEvents(history)) {
    if (payload.event !== 'post-merge') continue
    const run = eventText(payload, 'run')
    const result = eventText(payload, 'result')
    const sha = eventText(payload, 'sha')
    if (
      run !== null &&
      sha !== null &&
      record.runId === run &&
      (result === 'started' || result === 'ok' || result === 'skipped' || result === 'failed')
    ) {
      hooks.push({ run, result, sha })
    }
  }
  return hooks
}

function hasEpicFixEvent(history: DecodedHistory): boolean {
  return epicEvents(history).some(
    ({ record, payload }) => payload.event === 'epic-fix' && eventText(payload, 'run') === record.runId,
  )
}

/**
 * Everything `nextStep` reads. `git: false` leaves the worktree out (for
 * `objective`, which may run anywhere); `run` and `base` come from the gate.
 */
async function gather(
  repo: string,
  epic: number,
  run: string,
  base: string,
  { git: withGit = true, dashboard = true, reviews = true } = {},
): Promise<Gathered> {
  const { owner, name, full } = repoName(repo)
  const data = graphql<EpicData>(repo, EPIC_QUERY, { owner, name, epic })
  const issue = data.repository.issue
  if (!issue) throw new Refused(`#${epic} does not exist in ${full}`)
  if (issue.subIssues.pageInfo.hasNextPage) throw new Refused(`#${epic} has more than 100 sub-issues`)
  const nodes = issue.subIssues.nodes
  const elsewhere = nodes.filter((node) => node.repository.nameWithOwner !== full)
  if (elsewhere.length) {
    const names = elsewhere.map((node) => `${node.repository.nameWithOwner}#${node.number}`).join(', ')
    throw new Refused(`the Epic run delivers only ${full}; sub-issues elsewhere: ${names}`)
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
      if (same && ticketOfBranch(pr.headRefName) === node.number) found.set(pr.number, pr)
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
  const stopped = reviews ? await stoppedReviews(repo, full, open) : new Set<number>()
  const numbers = nodes.map((node) => node.number)
  const [epicHistory, childHistories] = await Promise.all([
    issueHistory(repo, full, epic),
    Promise.all(numbers.map(async (number) => [number, await issueHistory(repo, full, number)] as const)),
  ])
  const histories = new Map(childHistories)
  const refs = withGit ? branchRefs(repo, base, numbers) : new Map<number, BranchFacts[]>()
  const children: ChildFacts[] = []
  for (const node of nodes) {
    const history = histories.get(node.number)
    if (history === undefined) throw new Error(`missing history for #${node.number}`)
    const body = node.body ?? ''
    if (/<!--\s*omp-build:epic-fix\b/.test(body)) {
      throw new Refused(`#${node.number} has a legacy epic-fix body marker; publish a canonical epic-event instead`)
    }
    children.push({
      number: node.number,
      title: node.title,
      state: node.state,
      labels: node.labels.nodes.map((label) => label.name),
      body,
      epicFix: hasEpicFixEvent(history),
      blockedBy: node.blockedBy.nodes.map((blocker) =>
        blocker.repository.nameWithOwner === full
          ? { number: blocker.number, state: blocker.state }
          : { number: blocker.number, state: blocker.state, repo: blocker.repository.nameWithOwner },
      ),
      stops: stopsFromEvents(history),
      prs: (rawPrs.get(node.number) ?? []).map((pr) => prFacts(pr, stopped)),
      branches: refs.get(node.number) ?? [],
    })
  }
  const baseSha = withGit ? git(repo, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}^{commit}`]) : ''
  let landing: { required_checks: string[] } | null = null
  let landingError: string | null = null
  if (dashboard) {
    try {
      landing = readLanding(repo, { base })
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
    reviews: reviewsFromEvents(epicHistory),
    hooks: hooksFromEvents(epicHistory),
  }
  return { facts, epicHistory }
}

// ── Gate and location ─────────────────────────────────────────────────────────

function refusePrincipal(repo: string): void {
  const first = /^worktree (.+)$/m.exec(git(repo, ['worktree', 'list', '--porcelain']))?.[1]
  const here = realpathSync(git(repo, ['rev-parse', '--show-toplevel']))
  if (!first || (existsSync(first) && realpathSync(first) === here)) {
    throw new Refused(`${here} is the Principal; the Epic run continues in the epic worktree`)
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

function newEpicEvent(
  repository: string,
  issue: number,
  run: string,
  event: string,
  key: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
): Extract<CanonicalRecord, { kind: 'epic-event' }> {
  const recordId = `epic-event:${issue}:${run}:${event}:${key}`
  const parsed = buildRecord(
    {
      version: 1,
      recordId,
      runId: run,
      operationId: `${recordId}:publish`,
      repository,
      target: `${repository}#${issue}`,
      kind: 'epic-event',
      payload: { event, run, ...payload },
    },
    inputs,
  )
  if (!parsed.ok || parsed.value.kind !== 'epic-event') {
    throw new Error(`Epic event ${event} is not canonical: ${diagnosticsText(parsed.ok ? [] : parsed.diagnostics)}`)
  }
  return parsed.value
}

async function publishEpicEvent(
  repo: string,
  issue: number,
  run: string,
  event: string,
  key: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
): Promise<void> {
  const repository = repoName(repo).full
  const history = await issueHistory(repo, repository, issue)
  const record = newEpicEvent(repository, issue, run, event, key, payload, inputs)
  const publication = await publishGitHubRecord(record, history, adapterOptions(repo), null)
  if (publication.status !== 'confirmed') {
    throw new Error(`Epic event ${record.recordId} was not confirmed: ${diagnosticsText(publication.diagnostics)}`)
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

async function recordStop(repo: string, run: string, ticket: number, reason: string, detail: string): Promise<void> {
  await publishEpicEvent(repo, ticket, run, 'goal-stop', String(ticket), { reason, detail })
}

/**
 * The one way a ticket stops, whoever proved it: disarm every open PR of the
 * child, detach HEAD from its branch (kept), then publishes the canonical
 * `goal-stop` event. A PR that merged before its disarm is no stop: `merged`
 * names it, no event.
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
  await recordStop(repo, run, child.number, reason, detail)
  return { merged: null, disarmed }
}
// ── Confirmed mandate ─────────────────────────────────────────────────────────

export type EpicChildGrant = { scope: { repository: string; target: string }; specDigest: string; specBody: string }

export type EpicAuthority = {
  epic: number
  repository: string
  mandateId: string
  run: string
  base: string
  children: EpicChildGrant[]
  /** Child scopes a confirmed epic-fix record on this epic issue already admits. */
  extensions: { repository: string; target: string }[]
  proofPins: ProofConfigPin[]
  config: { productVersion: string; version: string; digest: string; effective: unknown }
}

const ASSISTED_MANDATE = 'no confirmed mandate authorizes epic'

function evidenceText(evidence: { message?: string }[] | undefined): string {
  return (
    evidence
      ?.map((item) => item.message)
      .filter(Boolean)
      .join('; ') || 'mandate refused'
  )
}

function localInhibit(history: DecodedHistory): 'pause' | 'abandon' | null {
  const confirmed = new Set<string>()
  const controls: { id: string; control: string }[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (record?.kind !== 'operator-control' || !record.payload || typeof record.payload !== 'object') continue
    const payload = record.payload as { control?: unknown; predecessor?: { recordId?: unknown } }
    if (typeof payload.control !== 'string') {
      throw new Refused('operator-control record has no control phase; continuation is not confirmed')
    }
    if (payload.control === 'pause-confirmed' && typeof payload.predecessor?.recordId === 'string') {
      confirmed.add(payload.predecessor.recordId)
    }
    controls.push({ id: record.recordId, control: payload.control })
  }
  if (controls.some((item) => item.control === 'abandon')) return 'abandon'
  if (controls.some((item) => item.control === 'pause-requested' && !confirmed.has(item.id))) return 'pause'
  return null
}

async function assertConfig(repo: string, effective: unknown): Promise<void> {
  const injected = effects.getStore()?.configCompatible
  const checked = await (injected ?? configCompatibility)(repo, effective)
  if (!checked.ok) throw new Refused(checked.error)
}

function childGrants(value: unknown): EpicChildGrant[] | string {
  if (!Array.isArray(value) || value.length === 0) return 'epic mandate names no approved child'
  const grants: EpicChildGrant[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return 'epic mandate child snapshot is unreadable'
    if (!('scope' in item) || !('specDigest' in item) || !('specBody' in item)) {
      return 'epic mandate child snapshot is unreadable'
    }
    const scope = item.scope
    if (!scope || typeof scope !== 'object' || !('repository' in scope) || !('target' in scope)) {
      return 'epic mandate child scope is unreadable'
    }
    if (
      typeof scope.repository !== 'string' ||
      typeof scope.target !== 'string' ||
      scope.repository === '' ||
      scope.target === ''
    ) {
      return 'epic mandate child scope is unreadable'
    }
    if (typeof item.specBody !== 'string' || typeof item.specDigest !== 'string') {
      return 'epic mandate child has no approved spec snapshot'
    }
    if (specDigest(item.specBody) !== item.specDigest) return 'epic mandate child specDigest does not match specBody'
    grants.push({
      scope: { repository: scope.repository, target: scope.target },
      specDigest: item.specDigest,
      specBody: item.specBody,
    })
  }
  return grants
}

function pinsOf(value: unknown): ProofConfigPin[] | string {
  if (!Array.isArray(value)) return 'epic mandate has no proof pins'
  const pins: ProofConfigPin[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return 'epic mandate proof pin is unreadable'
    const pin = item as { path?: unknown; sourceCommit?: unknown; blob?: unknown }
    if (typeof pin.path !== 'string' || pin.path === '' || typeof pin.sourceCommit !== 'string') {
      return 'epic mandate proof pin is not a path and source commit'
    }
    if (pin.blob !== null && typeof pin.blob !== 'string') return `proof pin ${pin.path} blob is not an identity`
    pins.push({ path: pin.path, sourceCommit: pin.sourceCommit, blob: pin.blob })
  }
  return pins
}

/**
 * The confirmed epic mandate on the epic issue. A missing record is assisted.
 * Pause, abandon, drift, and an unreadable parent are refusals. This does not
 * claim the epic is paused or disarmed.
 */
export async function readEpicAuthority(repo: string, epic: number): Promise<EpicAuthority> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) {
    throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  }
  const inhibit = localInhibit(history)
  if (inhibit) {
    throw new Refused(`continuation inhibited: ${inhibit} is requested and not confirmed`)
  }
  const external: DecodedHistory[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (
      record?.kind !== 'mandate' ||
      !record.payload ||
      typeof record.payload !== 'object' ||
      !('parent' in record.payload)
    ) {
      continue
    }
    const parent = record.payload.parent
    if (parent == null) continue
    if (
      typeof parent !== 'object' ||
      !('scope' in parent) ||
      !parent.scope ||
      typeof parent.scope !== 'object' ||
      !('repository' in parent.scope) ||
      !('target' in parent.scope) ||
      typeof parent.scope.repository !== 'string' ||
      typeof parent.scope.target !== 'string'
    ) {
      throw new Refused('epic mandate parent reference is unreadable')
    }
    const parentHistory = await historyFor(repo, parent.scope)
    if (!parentHistory.source.complete) throw new Refused('parent mandate history is incomplete')
    external.push(parentHistory)
  }
  const selected = selectApplicableMandate(history, external)
  if (selected.status === 'refused') {
    if (selected.reason === 'missing') throw new Assisted(`${ASSISTED_MANDATE} #${epic}`)
    throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
  }
  const payload = selected.mandate.payload as Record<string, unknown>
  if (payload.role !== 'epic') throw new Refused(`#${epic} mandate role is ${String(payload.role)}, not epic`)
  const permissions = payload.permissions as { landing?: unknown } | undefined
  if (permissions?.landing !== true) throw new Refused(`epic #${epic} mandate does not grant landing`)
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`epic #${epic} mandate run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`epic #${epic} mandate base is not a branch name`)
  }
  const grants = childGrants(payload.children)
  if (typeof grants === 'string') throw new Refused(grants)
  const proofPins = pinsOf(payload.proofPins)
  if (typeof proofPins === 'string') throw new Refused(proofPins)
  const config = payload.config as
    | { productVersion?: unknown; version?: unknown; digest?: unknown; effective?: unknown }
    | undefined
  if (
    !config ||
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string' ||
    !('effective' in config)
  ) {
    throw new Refused('epic mandate config identity is incomplete')
  }
  await assertConfig(repo, config.effective)
  return {
    epic,
    repository: full,
    mandateId: selected.mandate.recordId,
    run: payload.run,
    base: payload.base,
    children: grants,
    extensions: extensionScopes(history),
    proofPins,
    config: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      effective: config.effective,
    },
  }
}

function extensionScopes(history: DecodedHistory): { repository: string; target: string }[] {
  const scopes: { repository: string; target: string }[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (record?.kind !== 'epic-event' || !record.payload || typeof record.payload !== 'object') continue
    const payload = record.payload as Record<string, unknown>
    if (payload.event !== 'epic-fix' && payload.event !== 'mark-fix') continue
    const child = payload.child
    if (!child || typeof child !== 'object' || !('scope' in child)) continue
    const scope = child.scope
    if (!scope || typeof scope !== 'object' || !('repository' in scope) || !('target' in scope)) continue
    if (typeof scope.repository === 'string' && typeof scope.target === 'string') {
      scopes.push({ repository: scope.repository, target: scope.target })
    }
  }
  return scopes
}

export function assertChildGrant(authority: EpicAuthority, facts: Facts, ticket: number): void {
  const scope = githubScope(authority.repository, ticket)
  const grant = authority.children.find(
    (child) => child.scope.repository === scope.repository && child.scope.target === scope.target,
  )
  const extended = authority.extensions.some(
    (entry) => entry.repository === scope.repository && entry.target === scope.target,
  )
  if (!grant && !extended) throw new Refused(`#${ticket} is outside the epic mandate's approved child scope`)
  const live = facts.children.find((child) => child.number === ticket)
  if (!live) throw new Refused(`#${ticket} is not a sub-issue of #${authority.epic}`)
  if (grant && live.body !== grant.specBody) {
    throw new Refused(`#${ticket} issue body differs from the approved spec snapshot`)
  }
}

/** Order and blocked children for a publisher. Does not authorize a run or emit objective text. */
export async function frameEpicChildren(
  repo: string,
  epic: number,
  base: string,
): Promise<
  { order: number[]; blocked: { ticket: number; blockers: number[] }[] } | { error: string; missing?: number[] }
> {
  if (!BASE_NAME.test(base) || base.includes('..')) throw new Refused(`base ${base} is not a branch name`)
  const { facts } = await gather(repo, epic, '00000000', base, { git: false })
  return frameEpic({ base, children: facts.children })
}

export type NextOut = {
  run: string
  base: string
  step: Step
  recorded: { ticket: number; stop: string; disarmed?: Record<number, Disarm> }[]
  cleaned: string[]
  disarmed: Disarm | null
  reconciled: { ticket: number; pr: number; disarmed: Disarm | 'dry-run' }[]
}

async function next(repo: string, epic: number, dry: boolean, reread = 0): Promise<NextOut> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!dry) {
    refusePrincipal(repo)
    git(repo, ['fetch', '--prune', 'origin', '+refs/heads/*:refs/remotes/origin/*'])
  }
  let { facts } = await gather(repo, epic, run, base)
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
    facts = (await gather(repo, epic, run, base)).facts
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
    assertChildGrant(authority, facts, ticket)
    const child = facts.children.find((c) => c.number === ticket)
    if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
    if (dry) {
      recorded.push({ ticket, stop })
      child.stops.push({ run, reason: stop })
    } else {
      const outcome = await ticketStop(repo, run, base, child, stop, reason)
      if (outcome.merged === null) {
        recorded.push({ ticket, stop, disarmed: outcome.disarmed })
        child.stops.push({ run, reason: stop })
        facts.tree = tree(repo)
      } else facts = (await gather(repo, epic, run, base)).facts
    }
    step = nextStep(facts)
  }

  let disarmed: Disarm | null = null
  if (!dry && (step.action === 'start' || step.action === 'resume')) {
    const { ticket, branch } = step
    assertChildGrant(authority, facts, ticket)
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
        return next(repo, epic, dry, reread + 1)
      }
    }
  }
  return { run, base, step, recorded, cleaned, disarmed, reconciled }
}

async function stop(
  repo: string,
  epic: number,
  ticket: number,
  reason: string,
  detail: string,
): Promise<Record<string, unknown>> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (stopClass(reason) !== 'ticket') throw new Refused(`${reason} is not a ticket stop: ${TICKET_STOPS.join(', ')}`)
  refusePrincipal(repo)
  if (git(repo, ['status', '--porcelain']) !== '') {
    throw new Error(`the tree is dirty: commit #${ticket}'s work on its branch, subject ending (#${ticket}), first`)
  }
  const { facts } = await gather(repo, epic, run, base)
  assertChildGrant(authority, facts, ticket)
  const child = facts.children.find((c) => c.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  const outcome = await ticketStop(repo, run, base, child, reason, detail)
  if (outcome.merged !== null) return { ticket, merged: outcome.merged, disarmed: outcome.disarmed }
  return { ticket, stop: reason, sticky: STICKY_STOPS.includes(reason), disarmed: outcome.disarmed }
}

async function review(repo: string, epic: number, decisionRecord: string, range: string) {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!decisionRecord) throw new Refused('--decision-record <ID> is required')
  refusePrincipal(repo)
  const { facts, epicHistory } = await gather(repo, epic, run, base)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || step.range !== range) {
    throw new Refused(`the driver expects no final review of ${range} (next: ${step.action})`)
  }
  const authorityHistory = classifyHistory(epicHistory).authorityHistory
  const graph = validateRecordGraph(authorityHistory)
  if (!graph.ok) throw new Refused(`Epic review history is not admissible: ${diagnosticsText(graph.diagnostics)}`)
  const records = new Map(graph.value.map((record) => [record.recordId, record]))
  const decision = records.get(decisionRecord)
  if (decision?.kind !== 'decision')
    throw new Refused(`--decision-record ${decisionRecord} is not a canonical decision`)
  const synthesis = records.get(decision.payload.originalContributionId)
  const synthesisInventory =
    synthesis?.kind === 'contribution' && synthesis.payload.inventoryId !== null
      ? records.get(synthesis.payload.inventoryId)
      : null
  const root =
    synthesisInventory?.kind === 'review-attempt' ? records.get(synthesisInventory.payload.rootAttemptId) : null
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.subject.kind !== 'epic-range' ||
    root.payload.subject.range !== range
  ) {
    throw new Refused(`--decision-record ${decisionRecord} is not bound to the exact Epic range ${range}`)
  }
  const inventoryIds = [...records.values()]
    .filter(
      (record): record is Extract<CanonicalRecord, { kind: 'review-attempt' }> =>
        record.kind === 'review-attempt' && record.payload.rootAttemptId === root.recordId,
    )
    .map((record) => record.recordId)
  const assessment = validateDecision(decision, authorityHistory, loadReviewConfig().canonicalClasses, null)
  if (!assessment.admissible) {
    throw new Refused(
      `--decision-record ${decisionRecord} is not admissible: ${diagnosticsText(assessment.diagnostics)}`,
    )
  }
  await publishEpicEvent(
    repo,
    epic,
    run,
    'epic-review',
    `${range}:${decisionRecord}`,
    { decisionId: decisionRecord, inventoryIds, range },
    [decisionRecord, ...inventoryIds],
  )
  return { decisionRecord, range }
}

/**
 * After the existing trusted filing workflow creates a normal fix ticket, bind
 * that child to the one blocking Epic decision which authorizes the fix round.
 */
async function markFix(repo: string, epic: number, ticket: number): Promise<{ ticket: number; range: string }> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (!Number.isInteger(ticket) || ticket <= 0) throw new Refused('--ticket <N> is required')
  refusePrincipal(repo)
  const { facts } = await gather(repo, epic, run, base)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'fix-ticket') {
    throw new Refused(`the driver expects no final-review fix ticket (next: ${step.action})`)
  }
  const source = [...facts.reviews].reverse().find((review) => review.range === step.range)
  if (source?.verdict !== 'blocking') {
    throw new Refused(`the current final review for ${step.range} is not a blocking canonical decision`)
  }
  const child = facts.children.find((entry) => entry.number === ticket)
  if (!child) throw new Refused(`#${ticket} is not a sub-issue of #${epic}`)
  await publishEpicEvent(repo, ticket, run, 'epic-fix', String(ticket), {})
  await publishEpicEvent(repo, epic, run, 'epic-fix', `extend-${ticket}`, {
    child: { scope: { repository: authority.repository, target: githubScope(authority.repository, ticket).target } },
  })
  return { ticket, range: step.range }
}

async function hook(repo: string, epic: number): Promise<HookResult> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  refusePrincipal(repo)
  const { facts } = await gather(repo, epic, run, base)
  const step = nextStep(facts)
  if (step.action !== 'post-merge') throw new Refused(`the driver expects no post-merge hook (next: ${step.action})`)
  const mark = async (
    result: 'started' | HookResult['result'],
    sha: string,
    exitCode: number | null,
  ): Promise<void> => {
    await publishEpicEvent(repo, epic, run, 'post-merge', `${result}:${sha}`, { result, sha, exitCode })
  }
  let outcome: HookResult
  try {
    outcome = await runPostMergeHook(repo, base, {
      onStart: async (sha) => mark('started', sha, null),
    })
  } catch (error) {
    outcome = { result: 'failed', sha: null, detail: error instanceof Error ? error.message : String(error) }
  }
  const sha = outcome.sha ?? facts.baseSha
  await mark(outcome.result, sha, outcome.code ?? null)
  return outcome
}

async function report(
  repo: string,
  epic: number,
  outcome: string,
  reason: string,
): Promise<{ posted: boolean; text: string; stillArmed: number[] }> {
  const authority = await readEpicAuthority(repo, epic)
  const { run, base } = authority
  if (outcome !== 'complete' && outcome !== 'drop') throw new Refused(`--outcome must be complete or drop: ${outcome}`)
  refusePrincipal(repo)
  const disarmed: Record<number, Disarm> = {}
  const stillArmed: number[] = []
  let facts: Facts
  let epicHistory: DecodedHistory
  if (outcome === 'complete') {
    ;({ facts, epicHistory } = await gather(repo, epic, run, base))
    const step = nextStep(facts)
    if (step.action !== 'complete') throw new Refused(`the epic is not complete (next: ${step.action})`)
  } else {
    const light = await gather(repo, epic, run, base, { git: false, dashboard: false, reviews: false })
    const armed = light.facts.children
      .flatMap((child) => child.prs)
      .filter((pr) => pr.state === 'OPEN' && pr.armed)
      .sort((left, right) => left.number - right.number)
    for (const pr of armed) {
      try {
        disarmed[pr.number] = await disarm(repo, pr.number)
      } catch {
        stillArmed.push(pr.number)
      }
    }
    try {
      ;({ facts, epicHistory } = await gather(repo, epic, run, base))
      if (facts.landingError) facts = { ...facts, baseCi: { state: 'unread', failed: [], pending: [] } }
    } catch {
      facts = { ...light.facts, baseCi: { state: 'unread', failed: [], pending: [] } }
      epicHistory = light.epicHistory
    }
  }
  const summary = summarize(facts)
  const hook = hookStatus(facts).record
  const list = (items: number[]) => (items.length ? items.map((n) => `#${n}`).join(', ') : '—')
  const text = [
    `## Epic run \`${run}\` — ${outcome === 'complete' ? 'complete' : `dropped: \`${reason || 'unspecified'}\``}`,
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
  const posted = !epicEvents(epicHistory).some(({ payload }) => payload.event === 'goal-report' && payload.run === run)
  const named = stillArmed.length ? `still armed: ${stillArmed.map((pr) => `#${pr}`).join(', ')}` : ''
  if (named) {
    console.log(text)
    console.error(named)
  }
  if (posted) {
    await publishEpicEvent(repo, epic, run, 'goal-report', run, {
      outcome,
      reason,
      summary: summary as unknown as Json,
      hook: hook as unknown as Json,
      disarmed: disarmed as unknown as Json,
      stillArmed,
    })
  }
  if (named) throw new Error(named)
  return { posted, text, stillArmed }
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Free text — a stop detail — never travels as an argv word the caller had to
 * quote: it is read from a file, or stdin for `-`.
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
      'dry-run': { type: 'boolean', default: false },
      ticket: { type: 'string' },
      reason: { type: 'string', default: '' },
      'detail-file': { type: 'string' },
      'decision-record': { type: 'string', default: '' },
      range: { type: 'string', default: '' },
      outcome: { type: 'string', default: '' },
    },
  })
  const [command] = positionals
  const repo = realpathSync(values.repo ?? process.cwd())
  const epic = Number((values.epic ?? '').replace(/^#/, ''))
  if (!Number.isInteger(epic) || epic <= 0) throw new Refused('--epic <N> is required')
  const ticket = Number((values.ticket ?? '').replace(/^#/, ''))
  const detail = textFile(values['detail-file'], '--detail-file')
  switch (command) {
    case 'next':
      return JSON.stringify(await next(repo, epic, values['dry-run'] ?? false), null, 2)
    case 'stop':
      return JSON.stringify(await stop(repo, epic, ticket, values.reason, detail), null, 2)
    case 'review':
      return JSON.stringify(await review(repo, epic, values['decision-record'], values.range), null, 2)
    case 'mark-fix':
      return JSON.stringify(await markFix(repo, epic, ticket), null, 2)
    case 'control-disarm':
      return JSON.stringify(await disarmEpicControlTarget(repo, epic), null, 2)
    case 'hook': {
      const outcome = await hook(repo, epic)
      if (outcome.result === 'failed') throw new Error(`hook-failed ${JSON.stringify(outcome)}`)
      return JSON.stringify(outcome, null, 2)
    }
    case 'report': {
      const out = await report(repo, epic, values.outcome, values.reason)
      if (out.stillArmed.length) {
        console.log(out.text)
        throw new Error(`still armed: ${out.stillArmed.map((pr) => `#${pr}`).join(', ')}`)
      }
      return out.text
    }
    default:
      throw new Refused(
        `unknown subcommand ${command ?? '(none)'}: next | stop | mark-fix | review | hook | report | control-disarm`,
      )
  }
}

export type EpicControlState = 'active' | 'paused' | 'abandoned' | 'revoked'

/** Authenticated epic mandate for control only. Not a continuation or branch-switch grant. */
export type EpicControlTarget = {
  epic: number
  repository: string
  mandateId: string
  run: string
  base: string
  control: EpicControlState
  openPrs: { ticket: number; pr: number }[]
}

/** Disarm read-back. `control` is the observed state, not a pause confirmation. */
export type EpicDisarmEvidence = {
  control: EpicControlState
  mandateId: string
  disarmed: Record<number, Disarm>
  failed: { pr: number; error: string }[]
}

function lastIntactEpicMandate(history: DecodedHistory): { recordId: string; payload: Record<string, unknown> } | null {
  let found: { recordId: string; payload: Record<string, unknown> } | null = null
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || operation.authority === 'foreign') continue
    const record = operation.record
    if (record?.kind !== 'mandate' || !record.payload || typeof record.payload !== 'object') continue
    const payload = record.payload as Record<string, unknown>
    if (payload.role !== 'epic') continue
    found = { recordId: record.recordId, payload }
  }
  return found
}

function fieldsOfIntactMandate(
  payload: Record<string, unknown>,
  epic: number,
): { run: string; base: string; children: EpicChildGrant[] } {
  if (payload.role !== 'epic') throw new Refused(`#${epic} mandate role is ${String(payload.role)}, not epic`)
  if (typeof payload.run !== 'string' || !RUN_ID.test(payload.run)) {
    throw new Refused(`epic #${epic} mandate run is not an 8-character id`)
  }
  if (typeof payload.base !== 'string' || !BASE_NAME.test(payload.base) || payload.base.includes('..')) {
    throw new Refused(`epic #${epic} mandate base is not a branch name`)
  }
  const children = childGrants(payload.children)
  if (typeof children === 'string') throw new Refused(children)
  return { run: payload.run, base: payload.base, children }
}

/**
 * The intact epic mandate, including when continuation is paused, abandoned, or
 * revoked. Does not switch branches and does not authorize the next step.
 * Callable from Principal: the read is issue history and open PR facts only.
 */
export async function readEpicControlTarget(repo: string, epic: number): Promise<EpicControlTarget> {
  const { full } = repoName(repo)
  const history = await issueHistory(repo, full, epic)
  if (!history.source.complete) throw new Refused(`epic #${epic} history is incomplete; continuation is not confirmed`)
  const external: DecodedHistory[] = []
  for (const operation of history.operations) {
    const record = operation.record
    if (
      record?.kind !== 'mandate' ||
      !record.payload ||
      typeof record.payload !== 'object' ||
      !('parent' in record.payload)
    )
      continue
    const parent = record.payload.parent
    if (parent == null) continue
    if (
      typeof parent !== 'object' ||
      !('scope' in parent) ||
      !parent.scope ||
      typeof parent.scope !== 'object' ||
      !('repository' in parent.scope) ||
      !('target' in parent.scope) ||
      typeof parent.scope.repository !== 'string' ||
      typeof parent.scope.target !== 'string'
    ) {
      throw new Refused('epic mandate parent reference is unreadable')
    }
    const parentHistory = await historyFor(repo, parent.scope)
    if (!parentHistory.source.complete) throw new Refused('parent mandate history is incomplete')
    external.push(parentHistory)
  }
  const selected = selectApplicableMandate(history, external)
  const inhibit = localInhibit(history)
  let mandateId: string
  let payload: Record<string, unknown>
  let control: EpicControlState
  if (selected.status === 'applicable') {
    mandateId = selected.mandate.recordId
    payload = selected.mandate.payload as Record<string, unknown>
    control = inhibit === 'abandon' ? 'abandoned' : inhibit === 'pause' ? 'paused' : 'active'
  } else if (selected.reason === 'paused' || selected.reason === 'abandoned' || selected.reason === 'revoked') {
    const intact = lastIntactEpicMandate(history)
    if (!intact) throw new Refused(`epic #${epic} ${selected.reason} mandate record is not intact`)
    mandateId = intact.recordId
    payload = intact.payload
    control = selected.reason
  } else {
    if (selected.reason === 'missing') throw new Assisted(`${ASSISTED_MANDATE} #${epic}`)
    throw new Refused(`epic mandate ${selected.reason}: ${evidenceText(selected.evidence)}`)
  }
  const fields = fieldsOfIntactMandate(payload, epic)
  const { facts } = await gather(repo, epic, fields.run, fields.base, { git: false, dashboard: false, reviews: false })
  const approved = new Set([
    ...fields.children.map((child) => `${child.scope.repository}\0${child.scope.target}`),
    ...extensionScopes(history).map((scope) => `${scope.repository}\0${scope.target}`),
  ])
  const openPrs = facts.children.flatMap((child) => {
    const scope = githubScope(full, child.number)
    if (!approved.has(`${scope.repository}\0${scope.target}`)) return []
    return child.prs.filter((pr) => pr.state === 'OPEN').map((pr) => ({ ticket: child.number, pr: pr.number }))
  })
  return { epic, repository: full, mandateId, run: fields.run, base: fields.base, control, openPrs }
}

/**
 * Disarm open PRs of an authenticated intact mandate, active, paused, abandoned,
 * or revoked. A failed pause publication leaves the remote mandate active; this
 * call still disarms. No branch switch, no hook, no next-step grant, and no
 * pause record. `failed` is not durable pause.
 */
export async function disarmEpicControlTarget(repo: string, epic: number): Promise<EpicDisarmEvidence> {
  const target = await readEpicControlTarget(repo, epic)
  const disarmed: Record<number, Disarm> = {}
  const failed: { pr: number; error: string }[] = []
  for (const { pr } of target.openPrs) {
    try {
      disarmed[pr] = await disarm(repo, pr)
    } catch (error) {
      failed.push({ pr, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { control: target.control, mandateId: target.mandateId, disarmed, failed }
}

export type EpicRangeReviewRequest = {
  repository: string
  target: string
  runId: string
  range: string
  candidateGitSHA: string
}

/** Confirmed final-review context for the native range review. Does not dispatch it. */
export async function epicFinalReviewRequest(repo: string, epic: number): Promise<EpicRangeReviewRequest> {
  const authority = await readEpicAuthority(repo, epic)
  const { facts } = await gather(repo, epic, authority.run, authority.base)
  const step = nextStep(facts)
  if (step.action !== 'final-review' || step.stage !== 'review' || !step.range) {
    throw new Refused(`the driver expects no final review (next: ${step.action})`)
  }
  const candidateGitSHA = step.range.split('..')[1] ?? ''
  if (!/^[0-9a-f]{40}$/.test(candidateGitSHA))
    throw new Refused(`final review range ${step.range} has no candidate sha`)
  return {
    repository: authority.repository,
    target: githubScope(authority.repository, epic).target,
    runId: authority.run,
    range: step.range,
    candidateGitSHA,
  }
}

export type EpicStepRead = {
  run: string
  base: string
  step: Step
  name: EpicStepName
  land: null
}

/**
 * One `nextStep` read for traversal. Git status and refs are read, not moved.
 * No fetch, switch, disarm, stop publication, or hook. A `stop` is returned,
 * not recorded. Landing is `landOutcome`, not this read, so `land` is null.
 */
export async function readEpicStep(repo: string, epic: number): Promise<EpicStepRead> {
  const authority = await readEpicAuthority(repo, epic)
  const { facts } = await gather(repo, epic, authority.run, authority.base)
  const step = nextStep(facts)
  return { run: authority.run, base: authority.base, step, name: epicStepName(step), land: null }
}

export type EpicDriverPort = {
  readEpicAuthority: typeof readEpicAuthority
  frameEpicChildren: typeof frameEpicChildren
  next: (repo: string, epic: number, dry: boolean, reread?: number) => Promise<NextOut>
  readEpicStep: typeof readEpicStep
  stop: typeof stop
  markFix: typeof markFix
  review: typeof review
  hook: typeof hook
  report: typeof report
  epicFinalReviewRequest: typeof epicFinalReviewRequest
  readEpicControlTarget: typeof readEpicControlTarget
  disarmEpicControlTarget: typeof disarmEpicControlTarget
}

/** Real git and GitHub effects. Tests pass their own effects to `createEpicDriver`. */
export function createEpicDriver(injected: EpicEffects = {}): EpicDriverPort {
  const bind =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      effects.run(injected, () => fn(...args))
  return {
    readEpicAuthority: bind(readEpicAuthority),
    frameEpicChildren: bind(frameEpicChildren),
    next: bind(next),
    readEpicStep: bind(readEpicStep),
    stop: bind(stop),
    markFix: bind(markFix),
    review: bind(review),
    hook: bind(hook),
    report: bind(report),
    epicFinalReviewRequest: bind(epicFinalReviewRequest),
    readEpicControlTarget: bind(readEpicControlTarget),
    disarmEpicControlTarget: bind(disarmEpicControlTarget),
  }
}

const realDriver = createEpicDriver()
export const epicNext = realDriver.next
export const epicStep = realDriver.readEpicStep
export const epicStop = realDriver.stop
export const epicMarkFix = realDriver.markFix
export const epicHook = realDriver.hook
export const epicReport = realDriver.report
export const epicBindReview = realDriver.review
export const epicControlTarget = realDriver.readEpicControlTarget
export const epicDisarmControl = realDriver.disarmEpicControlTarget

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
