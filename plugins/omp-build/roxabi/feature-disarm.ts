// Source: plugins/omp-build/roxabi/workflow.ts:857-1023

import type { Gh } from '../adapters/github/types.ts'
import { epicControlTarget } from '../skills/feature/epic-driver.ts'
import { disarmReviewedBeforePush } from '../skills/feature/landing-foundation.js'
import { branchPrNumbers, type PullRequestList, parsePullRequestList } from './feature-disarm-discovery.ts'
import { authenticateOwnPullRequests, type SelectedMandateAuthority } from './feature-disarm-ownership.ts'
import { isRecord, type Scope } from './feature-engine.ts'
import { classifyIssueReference } from './prepare-canonical-checkout.ts'

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
  const explicitPr =
    target.status === 'pull-request' && role !== 'feature' && role !== 'epic' ? target.pullRequest.pr : null
  if (explicitPr !== null) discovered.numbers.delete(explicitPr)
  const authentication =
    explicitPr !== null && discovered.numbers.size === 0
      ? null
      : await authenticateOwnPullRequests(gh, cwd, target.scope.repository, discovered.numbers, authority)
  const numbers = authentication?.numbers ?? new Set<number>()
  if (explicitPr !== null) numbers.add(explicitPr)
  return {
    numbers,
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

async function selectedLocalRepository(gh: Gh, cwd: string, repository: string): Promise<boolean> {
  try {
    const repo: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
    return isRecord(repo) && repo.nameWithOwner === repository
  } catch {
    return false
  }
}

export async function disarmUnresolved(gh: Gh, cwd: string, reference: string): Promise<void> {
  const classified = classifyIssueReference(reference)
  if ('reason' in classified || !Number.isSafeInteger(classified.number) || classified.number <= 0) return
  const number = classified.number
  let repository: string | null = null
  if (classified.repository !== null) {
    if (!(await selectedLocalRepository(gh, cwd, classified.repository))) return
    repository = classified.repository
  }
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
    if (repository === null) {
      const repo: unknown = JSON.parse(await gh(cwd, ['repo', 'view', '--json', 'nameWithOwner']))
      if (!isRecord(repo) || typeof repo.nameWithOwner !== 'string') return
      repository = repo.nameWithOwner
    }
    await disarmKnownTarget(
      gh,
      cwd,
      {
        status: 'issue',
        scope: { repository, target: `${repository}#${number}` },
        issue: { number },
      },
      null,
    )
  } catch {
    // Attempted. Do not claim pause-confirmed.
  }
}
