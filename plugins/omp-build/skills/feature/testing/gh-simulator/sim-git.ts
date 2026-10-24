import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { persist } from './sim-state.ts'
import { type Check, fail, PASSING, type Pull, type State, stamp } from './sim-types.ts'

export function git(origin: string, args: string[]): string {
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

export function tip(origin: string, branch: string): string | null {
  try {
    const sha = git(origin, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return sha || null
  } catch {
    return null
  }
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
      .sort((left, right) => {
        const rank = (check: Check) => (check.status.toLowerCase() === 'completed' ? 0 : 1)
        const byStatus = rank(left) - rank(right)
        if (byStatus !== 0) return byStatus
        if (left.startedAt < right.startedAt) return -1
        if (left.startedAt > right.startedAt) return 1
        return 0
      })
      .at(-1)
    return winner ? [winner] : []
  })
}

export function nativeRollupNode(check: Check): Record<string, unknown> {
  if (check.kind === 'status-context') {
    const context = check.context ?? check.name
    const node: Record<string, unknown> = {
      __typename: 'StatusContext',
      context,
      state: (check.state ?? check.conclusion).toLowerCase(),
    }
    if (check.id === null) return node
    node.id = check.id === undefined ? `SC_${context}` : check.id
    return node
  }
  const node: Record<string, unknown> = {
    __typename: 'CheckRun',
    name: check.name,
    status: check.status.toLowerCase(),
    conclusion: check.conclusion.toLowerCase(),
    startedAt: check.startedAt,
    checkSuite: { workflowRun: { workflow: { name: check.workflowName } } },
  }
  if (check.id === null) return node
  node.id = check.id === undefined ? `CR_${check.workflowName}_${check.name}` : check.id
  return node
}

function rollupEntries(checks: Check[]): Check[] {
  const runs = collapsed(checks.filter((check) => check.kind !== 'status-context'))
  const winner = new Map(runs.map((check) => [`${check.workflowName}\0${check.name}`, check]))
  const seen = new Set<string>()
  const entries: Check[] = []
  for (const check of checks) {
    if (check.kind === 'status-context') {
      entries.push(check)
      continue
    }
    const key = `${check.workflowName}\0${check.name}`
    if (!seen.has(key)) {
      seen.add(key)
      const chosen = winner.get(key)
      if (chosen) entries.push(chosen)
    }
  }
  return entries
}

function requestedRollupSize(query: string, fallback: number): number {
  const requested = /contexts\(first:\s*(\d+)/.exec(query)
  return requested === null ? fallback : Number(requested[1])
}

function rollupStart(after: string | undefined): number | null {
  if (after === undefined || after.length === 0) return 0
  const match = /^sim-ci:(\d+)$/.exec(after)
  return match === null ? null : Number(match[1])
}

function validRollupPage(index: number | null, first: number, length: number): index is number {
  return (
    index !== null && Number.isInteger(index) && index >= 0 && index <= length && Number.isInteger(first) && first >= 1
  )
}

export function rollupPage(
  query: string,
  after: string | undefined,
  checks: Check[],
  omitPageInfo: boolean,
): { nodes: Record<string, unknown>[]; pageInfo?: { hasNextPage: boolean; endCursor: string | null } } {
  const entries = rollupEntries(checks)
  const first = requestedRollupSize(query, entries.length)
  const index = rollupStart(after)
  if (!validRollupPage(index, first, entries.length))
    return omitPageInfo ? { nodes: [] } : { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
  const slice = entries.slice(index, index + first)
  const next = index + slice.length
  const hasNextPage = next < entries.length
  return {
    nodes: slice.map(nativeRollupNode),
    pageInfo: omitPageInfo ? undefined : { hasNextPage, endCursor: hasNextPage ? `sim-ci:${next}` : null },
  }
}

function green(state: State, sha: string): boolean {
  if (!state.requiredChecks.length) return false
  const rows = collapsed(state.checks[sha] ?? [])
  return state.requiredChecks.every((name) => {
    const matching = rows.filter((item) => item.name === name)
    return (
      matching.every(
        (check) => check.status.toLowerCase() === 'completed' && Object.hasOwn(PASSING, check.conclusion.toLowerCase()),
      ) && matching.length > 0
    )
  })
}

export function refreshHead(state: State, pr: Pull): void {
  const sha = tip(state.origin, pr.headRefName)
  if (sha) pr.headRefOid = sha
}

export function recordedBase(state: State, pr: Pull): string | null {
  const at = `${pr.baseRefName}@${pr.headRefOid}`
  if (pr.baseRecord?.at !== at) {
    pr.baseRecord = { at, oid: tip(state.origin, pr.baseRefName) }
  }
  return pr.baseRecord.oid
}

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
    persist(state)
  } finally {
    try {
      git(state.origin, ['worktree', 'remove', '--force', scratch])
    } catch {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
}

function readyToSettle(state: State, pr: Pull): boolean {
  refreshHead(state, pr)
  const pin = pr.autoMerge?.matchHeadCommit
  return (pin === undefined || pin === pr.headRefOid) && armed(pr) && green(state, pr.headRefOid)
}

export function settle(state: State, pr: Pull): void {
  if (pr.state !== 'OPEN') return
  if (readyToSettle(state, pr)) mergeIntoOrigin(state, pr)
}

export function settleAll(state: State): void {
  for (const pr of Object.values(state.prs)) {
    try {
      settle(state, pr)
    } catch {
      // A conflict on one PR must not drop a sibling merge already persisted.
    }
  }
}
