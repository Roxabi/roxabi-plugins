import type { Gh } from '../adapters/github/types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { openPr } from '../skills/feature/workflow-pr.js'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type Contracts, type History, payload, type Scope } from './feature-engine.ts'
import type { GitRunner } from './workflow-pins.ts'

type Delivery = {
  number: number
  scope: Scope
  head: string
  branch: string
  base: string
  history: History
  issueScope: Scope
}

export function implementedCommits(history: History): string[] {
  for (const operation of [...history.operations].reverse()) {
    const record = operation.record
    if (record?.kind !== 'action-receipt' || record.payload.action !== 'implement' || record.payload.phase !== 'result')
      continue
    const structured = record.payload.structured
    if (
      structured === null ||
      typeof structured !== 'object' ||
      !('outcome' in structured) ||
      structured.outcome !== 'implemented'
    )
      continue
    if (!('commitSHAs' in structured) || !Array.isArray(structured.commitSHAs)) continue
    return structured.commitSHAs.filter((sha): sha is string => typeof sha === 'string')
  }
  return []
}

export async function remoteContains(
  git: GitRunner,
  cwd: string,
  branch: string,
  shas: readonly string[],
): Promise<boolean> {
  const fetched = await git(cwd, ['fetch', 'origin', branch])
  if (fetched.code !== 0) return false
  for (const sha of shas) {
    const contained = await git(cwd, ['merge-base', '--is-ancestor', sha, `origin/${branch}`])
    if (contained.code !== 0) return false
  }
  return shas.length > 0
}

/** Opens the PR after remote proof; null means the source effect completed. */
export async function openPullRequestAfterRemoteProof(
  history: History,
  issue: { title: string; body: string },
  number: number,
  git: GitRunner,
  gh: Gh,
  cwd: string,
  mandate: MandateRecord,
): Promise<ContinueFeatureResult | null> {
  const mandatePayload = payload(mandate)
  const branch = mandatePayload.branch
  const base = mandatePayload.base
  const shas = implementedCommits(history)
  if (typeof branch !== 'string' || typeof base !== 'string' || shas.length === 0) {
    return { kind: 'blocked', reason: 'implementation-not-remote' }
  }
  if (!(await remoteContains(git, cwd, branch, shas))) return { kind: 'blocked', reason: 'implementation-not-remote' }
  try {
    await openPr(cwd, { issue: number, branch, base, title: issue.title, body: issue.body }, { gh })
    return null
  } catch (error) {
    return { kind: 'blocked', reason: error instanceof Error ? error.message : 'publish-failed' }
  }
}

export function reviewAfterBinding(
  contracts: Contracts,
  issueHistory: History,
  delivery: Delivery | null,
  parents: readonly History[],
): ContinueFeatureResult {
  if (delivery === null) return { kind: 'blocked', reason: 'binding-missing' }
  const selected = contracts.selectApplicableMandate(issueHistory, parents)
  if (selected.status !== 'applicable' || selected.mandate === null) {
    return { kind: 'blocked', reason: 'binding-missing' }
  }
  const mandateId = selected.mandate.recordId
  const branch = selected.mandate.payload.branch
  const base = selected.mandate.payload.base
  if (typeof branch !== 'string' || typeof base !== 'string') return { kind: 'blocked', reason: 'binding-missing' }
  const bound = delivery.history.operations.some((operation) => {
    const record = operation.record
    return (
      operation.status === 'complete' &&
      record?.kind === 'workflow-binding' &&
      bindingMatches(record.payload, mandateId, branch, base)
    )
  })
  return bound ? { kind: 'review', pr: delivery.number } : { kind: 'blocked', reason: 'binding-missing' }
}

function bindingMatches(payload: Record<string, unknown>, mandateId: string, branch: string, base: string): boolean {
  const mandate = payload.mandate
  return (
    mandate !== null &&
    typeof mandate === 'object' &&
    'recordId' in mandate &&
    mandate.recordId === mandateId &&
    payload.branch === branch &&
    payload.base === base
  )
}
