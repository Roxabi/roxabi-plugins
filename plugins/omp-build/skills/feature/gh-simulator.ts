#!/usr/bin/env bun
/**
 * Stateful fake `gh` for the omp-build goal path (#654).
 *
 * Backed by `GH_SIM_STATE` (JSON). Answers only the calls `epic-driver.ts`,
 * `workflow.js` (`openPr`, `resolveReviewPr`, review history, `landPr`, the
 * disarms) and `ci-watch.sh` make. GraphQL is computed from the query's
 * variables. An unknown command or query exits non-zero and prints the argv.
 *
 * An open PR that is armed (native auto-merge, or the `reviewed` label) and
 * whose head has green `requiredChecks` merges on the next read: a real
 * `git merge --no-ff` into the bare `origin`. `pr merge --match-head-commit`
 * refuses when the sha is not the current head, and does not enable auto-merge.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Comment = { author: string; body: string }
type Check = {
  name: string
  status: string
  conclusion: string
  workflowName: string
  startedAt: string
}
type Issue = {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  author: string
  labels: string[]
  comments: Comment[]
  subIssues: number[]
  blockedBy: number[]
}
type Pull = {
  number: number
  title: string
  body: string
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  headRefName: string
  baseRefName: string
  headRefOid: string
  isCrossRepository: boolean
  labels: string[]
  autoMerge: { enabledAt: string; matchHeadCommit?: string } | null
  mergeCommit: { oid: string; parents: string[] } | null
  mergedAt: string | null
  comments: Comment[]
  /** Issues this PR closes (`Closes #N` and the same grammar). */
  closes: number[]
}
type Event = { event: string; label?: { name: string }; created_at: string }
type State = {
  viewer: string
  owner: string
  name: string
  defaultBranch: string
  /** Bare origin. Merge-on-read runs `git merge --no-ff` into it. */
  origin: string
  requiredChecks: string[]
  nextPr: number
  clock: number
  issues: Record<string, Issue>
  prs: Record<string, Pull>
  checks: Record<string, Check[]>
  events: Record<string, Event[]>
  calls: string[][]
}

const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*#(\d+)\b/gi
const PASSING: Record<string, true> = { success: true, skipped: true, neutral: true }

class SimError extends Error {}

function fail(message: string): never {
  throw new SimError(message)
}

function statePath(): string {
  const path = process.env.GH_SIM_STATE
  if (!path) fail('gh: GH_SIM_STATE is unset')
  return path
}

function withState<T>(fn: (state: State) => T): T {
  const path = statePath()
  const lock = `${path}.lock`
  const start = Date.now()
  for (;;) {
    try {
      mkdirSync(lock)
      break
    } catch {
      if (Date.now() - start > 10_000) fail(`gh: lock timeout ${lock}`)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
    }
  }
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as State
    const result = fn(state)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2))
    renameSync(tmp, path)
    return result
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function git(origin: string, args: string[]): string {
  return execFileSync(
    'git',
    [
      '--git-dir',
      origin,
      '-c',
      'user.name=gh-sim',
      '-c',
      'user.email=gh-sim@example.com',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim()
}

function tip(origin: string, branch: string): string | null {
  try {
    const sha = git(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return sha || null
  } catch {
    return null
  }
}

function closesOf(body: string): number[] {
  return [...body.matchAll(CLOSES)].map((match) => Number(match[1]))
}

function fullName(state: State): string {
  return `${state.owner}/${state.name}`
}

function stamp(state: State): string {
  const seconds = state.clock
  state.clock += 1
  return new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString().replace('.000Z', 'Z')
}

function armed(pr: Pull): boolean {
  return pr.autoMerge !== null || pr.labels.includes('reviewed')
}
function collapsed(checks: Check[]): Check[] {
  const groups = new Map<string, Check[]>()
  for (const check of checks) {
    const key = `${check.workflowName}\0${check.name}`
    const rows = groups.get(key) ?? []
    rows.push(check)
    groups.set(key, rows)
  }
  return [...groups.values()].flatMap((rows) => {
    const winner = [...rows]
      .sort((a, b) => {
        const rank = (check: Check) => (check.status.toLowerCase() === 'completed' ? 0 : 1)
        const byStatus = rank(a) - rank(b)
        if (byStatus !== 0) return byStatus
        return a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0
      })
      .at(-1)
    return winner ? [winner] : []
  })
}

function green(state: State, sha: string): boolean {
  if (!state.requiredChecks.length) return false
  const checks = state.checks[sha] ?? []
  return state.requiredChecks.every((name) => {
    const check = collapsed(checks).find((item) => item.name === name)
    return (
      check !== undefined &&
      check.status.toLowerCase() === 'completed' &&
      Object.hasOwn(PASSING, check.conclusion.toLowerCase())
    )
  })
}

function refreshHead(state: State, pr: Pull): void {
  const sha = tip(state.origin, pr.headRefName)
  if (sha) pr.headRefOid = sha
}

/** Real merge commit into the bare origin. First parent is the base tip. */
function mergeIntoOrigin(state: State, pr: Pull): void {
  refreshHead(state, pr)
  if (!pr.headRefOid) fail(`gh: PR #${pr.number} has no head`)
  const scratch = join(tmpdir(), `gh-sim-merge-${pr.number}-${process.pid}`)
  mkdirSync(scratch, { recursive: true })
  try {
    git(state.origin, ['worktree', 'add', '--detach', scratch, pr.baseRefName])
    execFileSync(
      'git',
      [
        '-C',
        scratch,
        '-c',
        'user.name=gh-sim',
        '-c',
        'user.email=gh-sim@example.com',
        '-c',
        'core.hooksPath=/dev/null',
        'merge',
        '--no-ff',
        pr.headRefOid,
        '-m',
        `Merge pull request #${pr.number} from ${pr.headRefName}`,
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const oid = execFileSync('git', ['-C', scratch, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const first = execFileSync('git', ['-C', scratch, 'rev-parse', 'HEAD^1'], { encoding: 'utf8' }).trim()
    const second = execFileSync('git', ['-C', scratch, 'rev-parse', 'HEAD^2'], { encoding: 'utf8' }).trim()
    git(state.origin, ['update-ref', `refs/heads/${pr.baseRefName}`, oid])
    pr.state = 'MERGED'
    pr.mergedAt = stamp(state)
    pr.mergeCommit = { oid, parents: [first, second] }
    pr.autoMerge = null
    for (const number of pr.closes) {
      const issue = state.issues[String(number)]
      if (issue && issue.state === 'OPEN') issue.state = 'CLOSED'
    }
  } finally {
    try {
      git(state.origin, ['worktree', 'remove', '--force', scratch])
    } catch {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

function settle(state: State, pr: Pull): void {
  if (pr.state !== 'OPEN') return
  refreshHead(state, pr)
  const pin = pr.autoMerge?.matchHeadCommit
  if (pin !== undefined && pin !== pr.headRefOid) return
  if (armed(pr) && green(state, pr.headRefOid)) mergeIntoOrigin(state, pr)
}

function settleAll(state: State): void {
  for (const pr of Object.values(state.prs)) settle(state, pr)
}

function prNode(state: State, pr: Pull): Record<string, unknown> {
  return {
    number: pr.number,
    state: pr.state,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    mergedAt: pr.mergedAt,
    isCrossRepository: pr.isCrossRepository,
    mergeCommit: pr.mergeCommit
      ? { oid: pr.mergeCommit.oid, parents: { nodes: [{ oid: pr.mergeCommit.parents[0] }] } }
      : null,
    autoMergeRequest: pr.autoMerge ? { enabledAt: pr.autoMerge.enabledAt } : null,
    labels: { nodes: pr.labels.map((name) => ({ name })) },
    repository: { nameWithOwner: fullName(state) },
  }
}

function commentNodes(comments: Comment[]): { body: string; author: { login: string } }[] {
  return comments.map((comment) => ({ body: comment.body, author: { login: comment.author } }))
}

function issueNode(state: State, issue: Issue): Record<string, unknown> {
  const linked = Object.values(state.prs).filter(
    (pr) => !pr.isCrossRepository && pr.closes.includes(issue.number) && pr.headRefName.length > 0,
  )
  const merged = linked.filter((pr) => pr.state === 'MERGED')
  const open = linked.filter((pr) => pr.state !== 'MERGED')
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    body: issue.body,
    author: { login: issue.author },
    repository: { nameWithOwner: fullName(state) },
    labels: { nodes: issue.labels.map((name) => ({ name })) },
    blockedBy: {
      nodes: issue.blockedBy.map((number) => {
        const blocker = state.issues[String(number)]
        return {
          number,
          state: blocker?.state ?? 'OPEN',
          repository: { nameWithOwner: fullName(state) },
        }
      }),
    },
    comments: { nodes: commentNodes(issue.comments) },
    closedByPullRequestsReferences: { nodes: merged.map((pr) => prNode(state, pr)) },
    timelineItems: {
      nodes: open.map((pr) => ({ source: prNode(state, pr) })),
    },
  }
}

function flags(argv: string[]): { positionals: string[]; flag: Map<string, string[]>; bool: Set<string> } {
  const positionals: string[] = []
  const flag = new Map<string, string[]>()
  const bool = new Set<string>()
  const takes: Record<string, true> = {
    '--json': true,
    '--jq': true,
    '--method': true,
    '--repo': true,
    '--head': true,
    '--base': true,
    '--state': true,
    '--add-label': true,
    '--remove-label': true,
    '--body': true,
    '--body-file': true,
    '--match-head-commit': true,
    '-f': true,
    '-F': true,
    '-R': true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (takes[arg]) {
      const value = argv[++i]
      if (value === undefined) fail(`gh: ${arg} needs a value\n${argv.join(' ')}`)
      const list = flag.get(arg) ?? []
      list.push(value)
      flag.set(arg, list)
    } else if (arg.startsWith('--')) bool.add(arg)
    else positionals.push(arg)
  }
  return { positionals, flag, bool }
}

function one(flag: Map<string, string[]>, name: string): string | undefined {
  return flag.get(name)?.at(-1)
}

function fields(flag: Map<string, string[]>, pr: Pull, state: State): Record<string, unknown> {
  const wanted = (one(flag, '--json') ?? '').split(',').filter(Boolean)
  const all: Record<string, unknown> = {
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    baseRefName: pr.baseRefName,
    headRefName: pr.headRefName,
    headRefOid: pr.headRefOid,
    isCrossRepository: pr.isCrossRepository,
    mergeStateStatus: pr.state === 'MERGED' ? 'UNKNOWN' : 'CLEAN',
    autoMergeRequest: pr.autoMerge ? { enabledAt: pr.autoMerge.enabledAt } : null,
    labels: pr.labels.map((name) => ({ name })),
    comments: commentNodes(pr.comments),
    statusCheckRollup: (state.checks[pr.headRefOid] ?? []).map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      workflowName: check.workflowName,
      startedAt: check.startedAt,
    })),
  }
  if (!wanted.length) return all
  const out: Record<string, unknown> = {}
  for (const key of wanted) out[key] = all[key] ?? null
  return out
}

function jq(expression: string, json: string): string {
  return execFileSync('jq', ['-r', expression], { input: json, encoding: 'utf8' })
}

function emit(value: unknown, expression: string | undefined): void {
  const json = typeof value === 'string' ? value : JSON.stringify(value)
  if (!expression) {
    process.stdout.write(`${json}\n`)
    return
  }
  process.stdout.write(jq(expression, json))
}

function varsOf(flag: Map<string, string[]>): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const pair of [...(flag.get('-f') ?? []), ...(flag.get('-F') ?? [])]) {
    const at = pair.indexOf('=')
    if (at === -1) continue
    vars[pair.slice(0, at)] = pair.slice(at + 1)
  }
  return vars
}

function graphql(state: State, query: string, vars: Record<string, string>): unknown {
  const owner = vars.owner
  const name = vars.name
  if (owner !== state.owner || name !== state.name) {
    return { data: { repository: null, viewer: { login: state.viewer } } }
  }
  if (query.includes('subIssues')) {
    const epic = state.issues[String(vars.epic)]
    settleAll(state)
    return {
      data: {
        viewer: { login: state.viewer },
        repository: {
          issue: epic
            ? {
                comments: { nodes: commentNodes(epic.comments) },
                subIssues: {
                  pageInfo: { hasNextPage: false },
                  nodes: epic.subIssues.map((number) => issueNode(state, state.issues[String(number)] as Issue)),
                },
              }
            : null,
        },
      },
    }
  }
  if (query.includes('statusCheckRollup')) {
    const sha = vars.sha ?? ''
    const nodes = collapsed(state.checks[sha] ?? []).map((check) => ({
      __typename: 'CheckRun',
      name: check.name,
      status: check.status.toLowerCase(),
      conclusion: check.conclusion.toLowerCase(),
      startedAt: check.startedAt,
      checkSuite: { workflowRun: { workflow: { name: check.workflowName } } },
    }))
    return {
      data: {
        repository: {
          object: sha ? { statusCheckRollup: { contexts: { nodes } } } : null,
        },
      },
    }
  }
  const pulls = [...query.matchAll(/(\w+):\s*pullRequest\(number:\s*(\d+)\)/g)]
  if (pulls.length) {
    settleAll(state)
    const repository: Record<string, unknown> = {}
    for (const match of pulls) {
      const alias = match[1] ?? ''
      const pr = state.prs[match[2] ?? '']
      repository[alias] = pr ? { comments: { nodes: commentNodes(pr.comments) } } : null
    }
    return { data: { repository } }
  }
  fail(`gh: unhandled graphql query\n${query}`)
}

function requirePr(state: State, number: string): Pull {
  const pr = state.prs[number]
  if (!pr) fail(`gh: pull request #${number} not found`)
  return pr
}

function handle(state: State, argv: string[]): void {
  state.calls.push(argv)
  const { positionals, flag, bool } = flags(argv)
  const [cmd, sub] = positionals
  const expression = one(flag, '--jq')

  if (cmd === 'repo' && sub === 'view') {
    const repo = {
      nameWithOwner: fullName(state),
      defaultBranchRef: { name: state.defaultBranch },
    }
    emit(repo, expression)
    return
  }

  if (cmd === 'api' && sub === 'user') {
    emit({ login: state.viewer }, expression)
    return
  }

  if (cmd === 'api' && sub === 'graphql') {
    const vars = varsOf(flag)
    emit(graphql(state, vars.query ?? '', vars), expression)
    return
  }

  if (cmd === 'api' && one(flag, '--method') === 'POST' && (sub ?? '').endsWith('/pulls')) {
    const form = varsOf(flag)
    const head = form.head ?? ''
    const base = form.base ?? state.defaultBranch
    const sha = tip(state.origin, head)
    if (!sha) fail(`gh: head ${head} is not on ${state.origin}`)
    const number = state.nextPr
    state.nextPr += 1
    const pr: Pull = {
      number,
      title: form.title ?? '',
      body: form.body ?? '',
      state: 'OPEN',
      headRefName: head,
      baseRefName: base,
      headRefOid: sha,
      isCrossRepository: false,
      labels: [],
      autoMerge: null,
      mergeCommit: null,
      mergedAt: null,
      comments: [],
      closes: closesOf(form.body ?? ''),
    }
    state.prs[String(number)] = pr
    emit({ number, html_url: `https://example.test/${fullName(state)}/pull/${number}` }, expression)
    return
  }

  if (cmd === 'api' && sub?.includes('/events')) {
    const number = sub.match(/issues\/(\d+)\/events/)?.[1]
    if (!number) fail(`gh: unhandled ${argv.join(' ')}`)
    emit(state.events[number] ?? [], expression)
    return
  }

  if (cmd === 'api' && sub?.includes('/protection/required_status_checks')) {
    emit({ required_status_checks: { contexts: [] } }, expression)
    return
  }

  if (cmd === 'api' && sub?.includes('/rules/branches/')) {
    emit([], expression)
    return
  }

  if (cmd === 'api' && sub?.includes('/check-runs')) {
    emit({ check_runs: [] }, expression)
    return
  }

  if (cmd === 'issue' && sub === 'comment') {
    const number = positionals[2] ?? ''
    const issue = state.issues[number]
    if (!issue) fail(`gh: issue #${number} not found`)
    const file = one(flag, '--body-file')
    const body =
      file === '-' ? readFileSync(0, 'utf8') : file ? readFileSync(file, 'utf8') : (one(flag, '--body') ?? '')
    issue.comments.push({ author: state.viewer, body })
    process.stdout.write(
      `https://example.test/${fullName(state)}/issues/${number}#issuecomment-${issue.comments.length}\n`,
    )
    return
  }

  if (cmd === 'pr' && sub === 'list') {
    settleAll(state)
    const head = one(flag, '--head')
    const base = one(flag, '--base')
    const wanted = one(flag, '--state') ?? 'open'
    const rows = Object.values(state.prs)
      .filter((pr) => (head ? pr.headRefName === head : true))
      .filter((pr) => (base ? pr.baseRefName === base : true))
      .filter((pr) => (wanted === 'all' ? true : pr.state === wanted.toUpperCase()))
      .map((pr) => fields(flag, pr, state))
    emit(rows, expression)
    return
  }

  if (cmd === 'pr' && sub === 'view') {
    const pr = requirePr(state, positionals[2] ?? '')
    settle(state, pr)
    emit(fields(flag, pr, state), expression)
    return
  }

  if (cmd === 'pr' && sub === 'comment') {
    const pr = requirePr(state, positionals[2] ?? '')
    const file = one(flag, '--body-file')
    const body =
      file === '-' ? readFileSync(0, 'utf8') : file ? readFileSync(file, 'utf8') : (one(flag, '--body') ?? '')
    pr.comments.push({ author: state.viewer, body })
    process.stdout.write(
      `https://example.test/${fullName(state)}/pull/${pr.number}#issuecomment-${pr.comments.length}\n`,
    )
    return
  }

  if (cmd === 'pr' && sub === 'edit') {
    const pr = requirePr(state, positionals[2] ?? '')
    const add = one(flag, '--add-label')
    const remove = one(flag, '--remove-label')
    if (add && !pr.labels.includes(add)) {
      pr.labels.push(add)
      const events = state.events[String(pr.number)] ?? []
      events.push({ event: 'labeled', label: { name: add }, created_at: stamp(state) })
      state.events[String(pr.number)] = events
    }
    if (remove) pr.labels = pr.labels.filter((label) => label !== remove)
    process.stdout.write(`https://example.test/${fullName(state)}/pull/${pr.number}\n`)
    return
  }

  if (cmd === 'pr' && sub === 'merge') {
    const pr = requirePr(state, positionals[2] ?? '')
    if (bool.has('--disable-auto')) {
      pr.autoMerge = null
      process.stdout.write('\n')
      return
    }
    if (bool.has('--auto') && bool.has('--merge')) {
      const pin = one(flag, '--match-head-commit')
      refreshHead(state, pr)
      if (pin !== undefined && pin !== pr.headRefOid) {
        fail(`match-head-commit ${pin} does not match head ${pr.headRefOid}`)
      }
      if (pr.autoMerge) fail('auto-merge already enabled')
      pr.autoMerge = { enabledAt: stamp(state), ...(pin ? { matchHeadCommit: pin } : {}) }
      process.stdout.write('\n')
      return
    }
  }

  if (cmd === 'run' && sub === 'list') {
    emit([], expression)
    return
  }

  if (cmd === 'run' && sub === 'view') {
    process.stdout.write('\n')
    return
  }

  fail(`gh: unhandled ${argv.join(' ')}`)
}

const argv = process.argv.slice(2)
try {
  withState((state) => handle(state, argv))
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const text =
    message.startsWith('match-head-commit') || message.startsWith('auto-merge') || message.startsWith('gh:')
      ? message
      : `gh: ${message}\n${argv.join(' ')}`
  process.stderr.write(`${text}\n`)
  process.exit(1)
}
