// Source: plugins/omp-build/roxabi/workflow.ts:857-1023

import type { Gh } from '../adapters/github/types.ts'
import { epicDisarmControl } from '../skills/feature/epic-driver.ts'
import { disarmReviewedBeforePush } from '../skills/feature/landing-foundation.js'
import { isRecord, type Scope } from './feature-engine.ts'

export type ControlTarget =
  | { status: 'issue'; scope: Scope; issue: { number: number } }
  | { status: 'pull-request'; scope: Scope; pullRequest: { pr: number } }

type PullRequestList = { numbers: number[]; incomplete: boolean; evidence: unknown }

function parsePullRequestList(source: 'linked' | 'branch', raw: string): PullRequestList {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return {
      numbers: [],
      incomplete: true,
      evidence: { source, status: 'invalid-json', error: error instanceof Error ? error.message : 'invalid-json' },
    }
  }
  if (!Array.isArray(parsed)) {
    return { numbers: [], incomplete: true, evidence: { source, status: 'non-array-response' } }
  }
  const numbers: number[] = []
  let invalid = false
  for (const item of parsed) {
    if (item === null || typeof item !== 'object' || !('number' in item) || typeof item.number !== 'number') {
      invalid = true
      continue
    }
    numbers.push(item.number)
  }
  return {
    numbers,
    incomplete: invalid,
    evidence: { source, status: invalid ? 'invalid-entries' : 'complete', numbers },
  }
}

async function openLinkedPullRequests(
  gh: Gh,
  cwd: string,
  repository: string,
  issue: number,
): Promise<PullRequestList> {
  try {
    const raw = await gh(cwd, [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--search',
      `linked:issue:${issue}`,
      '--json',
      'number',
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

async function openBranchPullRequests(
  gh: Gh,
  cwd: string,
  repository: string,
  branch: string,
): Promise<PullRequestList> {
  try {
    const raw = await gh(cwd, [
      'pr',
      'list',
      '--repo',
      repository,
      '--state',
      'open',
      '--head',
      branch,
      '--json',
      'number',
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

async function disarmEpicTarget(cwd: string, issue: number): Promise<DisarmResult> {
  try {
    const evidence = await epicDisarmControl(cwd, issue)
    return { clean: evidence.failed.length === 0, evidence }
  } catch (error) {
    return { clean: false, evidence: { error: error instanceof Error ? error.message : 'epic-disarm-unavailable' } }
  }
}

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
    const linked = await openLinkedPullRequests(gh, cwd, target.scope.repository, target.issue.number)
    for (const pr of linked.numbers) numbers.add(pr)
    incomplete ||= linked.incomplete
    evidence.push(linked.evidence)
  }
  if (branch !== null && branch.length > 0) {
    const branchPullRequests = await openBranchPullRequests(gh, cwd, target.scope.repository, branch)
    for (const pr of branchPullRequests.numbers) numbers.add(pr)
    incomplete ||= branchPullRequests.incomplete
    evidence.push(branchPullRequests.evidence)
  }
  return { numbers, incomplete, evidence }
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

export async function disarmKnownTarget(
  gh: Gh,
  cwd: string,
  target: ControlTarget,
  role: 'feature' | 'epic' | 'fix-only' | null = null,
  branch: string | null = null,
): Promise<DisarmResult> {
  // Epic owns role-aware child/PR disarm. Ordinary Feature never calls epicDisarmControl.
  if (target.status === 'issue' && role === 'epic') return disarmEpicTarget(cwd, target.issue.number)
  const discovered = await discoverPullRequests(gh, cwd, target, branch)
  const discovery = { incomplete: discovered.incomplete, evidence: discovered.evidence }
  if (discovered.numbers.size === 0) {
    // Empty discovery is not observed disarm when incomplete or a branch was
    // expected. Issue-only with complete empty lists stays clean.
    return {
      clean: !discovered.incomplete && target.status === 'issue',
      evidence: {
        disarmed: [],
        role: role ?? 'unknown',
        note: discovered.incomplete ? 'pull-request-list-incomplete' : 'no-open-pull-requests',
        branch,
        discovery,
      },
    }
  }
  const result = await disarmPullRequests(gh, cwd, discovered.numbers)
  return {
    clean: !discovered.incomplete && result.clean,
    evidence: {
      disarmed: result.evidence,
      role: role ?? 'unknown',
      branch,
      discovery,
      ...(discovered.incomplete ? { note: 'pull-request-list-incomplete' } : {}),
    },
  }
}

export async function disarmUnresolved(gh: Gh, cwd: string, reference: string): Promise<void> {
  const number = Number(reference.replace(/^.*?(\d+)$/, '$1'))
  if (!Number.isInteger(number) || number <= 0) return
  try {
    await gh(cwd, ['pr', 'view', String(number), '--json', 'number'])
    await disarmReviewedBeforePush(cwd, number, { gh })
    return
  } catch {
    // Not a pull request. Disarm open linked PRs only; do not assume Epic.
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
