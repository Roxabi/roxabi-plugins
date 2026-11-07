// Source: plugins/omp-build/roxabi/workflow.ts:857-1023

import type { Gh } from '../adapters/github/types.ts'
import { epicControlTarget } from '../skills/feature/epic-driver.ts'
import { disarmReviewedBeforePush } from '../skills/feature/landing-foundation.js'
import { type PullRequestList, parsePullRequestList } from './feature-disarm-discovery.ts'
import { authenticateOwnPullRequests, type SelectedMandateAuthority } from './feature-disarm-ownership.ts'
import { isRecord, type Scope } from './feature-engine.ts'

export type ControlTarget =
  | { status: 'issue'; scope: Scope; issue: { number: number } }
  | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number } }

async function linkedPullRequests(gh: Gh, cwd: string, repository: string, issue: number): Promise<PullRequestList> {
  try {
    const raw = await gh(cwd, [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'all',
      '--search',
      `linked:issue:${issue}`,
      '--limit',
      '1000',
      '--json',
      'number,state',
    ])
    return parsePullRequestList('linked', raw)
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source: 'linked', status: 'failed', error: error instanceof Error ? error.message : 'list-failed' },
    }
  }
}

async function branchPullRequests(gh: Gh, cwd: string, repository: string, branch: string): Promise<PullRequestList> {
  try {
    const raw = await gh(cwd, [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'all',
      '--head',
      branch,
      '--limit',
      '1000',
      '--json',
      'number,state',
    ])
    return parsePullRequestList('branch', raw)
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source: 'branch', status: 'failed', error: error instanceof Error ? error.message : 'list-failed' },
    }
  }
}

type DisarmResult = { clean: boolean; evidence: unknown }

async function discoverPullRequests(
  gh: Gh,
  cwd: string,
  target: ControlTarget,
  branch: string | null,
): Promise<{ numbers: Set<number>; incomplete: boolean; evidence: unknown[] }> {
  const numbers = new Set<number>()
  const evidence: unknown[] = []
  let incomplete = false
  if (target.status === 'pull-request') numbers.add(target.pullRequest.pr)
  if (target.status === 'issue') {
    const linked = await linkedPullRequests(gh, cwd, target.scope.repository, target.issue.number)
    for (const pr of linked.numbers) numbers.add(pr)
    incomplete ||= linked.incomplete
    evidence.push(linked.evidence)
  }
  if (branch !== null && branch.length > 0) {
    const branchPrs = await branchPullRequests(gh, cwd, target.scope.repository, branch)
    for (const pr of branchPrs.numbers) numbers.add(pr)
    incomplete ||= branchPrs.incomplete
    evidence.push(branchPrs.evidence)
  }
  return { numbers, incomplete, evidence }
}

async function discoverApprovedChildPullRequests(
  cwd: string,
  issue: number,
): Promise<{ numbers: Set<number>; incomplete: boolean; evidence: unknown }> {
  try {
    const control = await epicControlTarget(cwd, issue)
    return {
      numbers: new Set(control.openPrs.map(({ pr }) => pr)),
      incomplete: false,
      evidence: {
        status: 'complete',
        mandateId: control.mandateId,
        control: control.control,
        openPrs: control.openPrs,
      },
    }
  } catch (error) {
    return {
      numbers: new Set(),
      incomplete: true,
      evidence: {
        status: 'unconfirmed',
        error: error instanceof Error ? error.message : 'epic-control-discovery-unavailable',
      },
    }
  }
}

function disarmSucceeded(result: unknown): boolean {
  return (
    isRecord(result) &&
    Object.keys(result).length === 1 &&
    ['disarmed', 'unarmed', 'closed', 'merged'].some((state) => result[state] === true)
  )
}

async function disarmPullRequests(gh: Gh, cwd: string, numbers: Set<number>): Promise<DisarmResult> {
  const disarmed: unknown[] = []
  let clean = true
  for (const pr of numbers) {
    try {
      const result = await disarmReviewedBeforePush(cwd, pr, { gh })
      disarmed.push({ pr, result })
      if (!disarmSucceeded(result)) clean = false
    } catch (error) {
      clean = false
      disarmed.push({ pr, error: error instanceof Error ? error.message : 'disarm-failed' })
    }
  }
  return { clean, evidence: disarmed }
}

function unmergedBranchPrNumber(pr: unknown): number | null | undefined {
  if (
    !isRecord(pr) ||
    !Number.isSafeInteger(pr.number) ||
    (pr.number as number) <= 0 ||
    (pr.state !== 'open' && pr.state !== 'closed') ||
    !('merged_at' in pr) ||
    (pr.merged_at !== null && typeof pr.merged_at !== 'string') ||
    (pr.state === 'open' && pr.merged_at !== null) ||
    (typeof pr.merged_at === 'string' && !pr.merged_at)
  )
    return undefined
  return pr.merged_at === null ? (pr.number as number) : null
}

async function branchPrNumbers(gh: Gh, cwd: string, endpoint: string): Promise<Set<number> | null> {
  const numbers = new Set<number>()
  for (let page = 1; ; page++) {
    const results: unknown = JSON.parse(await gh(cwd, ['api', `${endpoint}&page=${page}`]))
    if (!Array.isArray(results) || results.length > 100) return null
    for (const pr of results) {
      const number = unmergedBranchPrNumber(pr)
      if (number === undefined) return null
      if (number !== null) numbers.add(number)
    }
    if (results.length < 100) return numbers
  }
}

/** Fence every unmerged PR targeting this repository from the branch before a push. */
export async function disarmBranchBeforePush(
  gh: Gh,
  cwd: string,
  repository: string,
  branch: string,
): Promise<boolean> {
  const [owner, name, ...rest] = repository.split('/')
  if (!owner || !name || rest.length !== 0 || !branch) return false
  try {
    const endpoint = `repos/${owner}/${name}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`
    const numbers = await branchPrNumbers(gh, cwd, endpoint)
    return numbers !== null && (await disarmPullRequests(gh, cwd, numbers)).clean
  } catch {
    return false
  }
}

async function discoverOwnPullRequests(
  gh: Gh,
  cwd: string,
  target: ControlTarget,
  role: 'feature' | 'epic' | 'fix-only' | null,
  branch: string | null,
  authority: SelectedMandateAuthority | null,
): Promise<{ numbers: Set<number>; incomplete: boolean; evidence: unknown[] }> {
  const discovered = await discoverPullRequests(gh, cwd, target, branch)
  const authentication =
    role === 'feature' || role === 'epic'
      ? await authenticateOwnPullRequests(gh, cwd, target.scope.repository, discovered.numbers, authority)
      : null
  return {
    numbers: authentication?.numbers ?? discovered.numbers,
    incomplete: discovered.incomplete || authentication?.incomplete === true,
    evidence: [...discovered.evidence, ...(authentication === null ? [] : [{ ownership: authentication.evidence }])],
  }
}

export async function disarmKnownTarget(
  gh: Gh,
  cwd: string,
  target: ControlTarget,
  role: 'feature' | 'epic' | 'fix-only' | null = null,
  branch: string | null = null,
  authority: SelectedMandateAuthority | null = null,
): Promise<DisarmResult> {
  const own = await discoverOwnPullRequests(gh, cwd, target, role, branch, authority)
  const children =
    target.status === 'issue' && role === 'epic'
      ? await discoverApprovedChildPullRequests(cwd, target.issue.number)
      : null
  const numbers = new Set([...own.numbers, ...(children?.numbers ?? [])])
  const incomplete = own.incomplete || children?.incomplete === true
  const discovery = {
    own: { incomplete: own.incomplete, evidence: own.evidence },
    ...(children === null ? {} : { children: { incomplete: children.incomplete, evidence: children.evidence } }),
  }
  if (numbers.size === 0) {
    return {
      clean: !incomplete && target.status === 'issue',
      evidence: {
        disarmed: [],
        role: role ?? 'unknown',
        note: incomplete ? 'pull-request-list-incomplete' : 'no-unmerged-pull-requests',
        branch,
        discovery,
      },
    }
  }
  const result = await disarmPullRequests(gh, cwd, numbers)
  return {
    clean: !incomplete && result.clean,
    evidence: {
      disarmed: result.evidence,
      role: role ?? 'unknown',
      branch,
      discovery,
      ...(incomplete ? { note: 'pull-request-list-incomplete' } : {}),
    },
  }
}

export async function disarmUnresolved(gh: Gh, cwd: string, reference: string): Promise<void> {
  const number = Number(reference.replace(/^.*?(\d+)$/, '$1'))
  if (!Number.isInteger(number) || number <= 0) return
  let isPullRequest = false
  try {
    await gh(cwd, ['pr', 'view', String(number), '--json', 'number'])
    isPullRequest = true
  } catch {
    // Not a pull request. Attempt linked PRs only; do not assume Epic.
  }
  if (isPullRequest) {
    try {
      await disarmReviewedBeforePush(cwd, number, { gh })
    } catch {
      // Attempted. Do not claim pause-confirmed or reinterpret a failed withdrawal as an issue.
    }
    return
  }
  try {
    const repoRaw = await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner'])
    const repo: unknown = JSON.parse(repoRaw)
    if (
      repo === null ||
      typeof repo !== 'object' ||
      !('nameWithOwner' in repo) ||
      typeof repo.nameWithOwner !== 'string'
    )
      return
    await disarmKnownTarget(
      gh,
      cwd,
      {
        status: 'issue',
        scope: { repository: repo.nameWithOwner, target: `${repo.nameWithOwner}#${number}` },
        issue: { number },
      },
      null,
    )
  } catch {
    // Attempted. Do not claim pause-confirmed.
  }
}
