// Source: plugins/omp-build/roxabi/workflow.ts:563-636,1024-1027
import { realpathSync } from 'node:fs'
import type { ContinueFeatureResult } from './feature-contract.ts'
import { type HistoryRecord, isRecord, payload, type Scope } from './feature-engine.ts'
import type { GitRunner } from './workflow-checkout.ts'
import { prepareFeatureCheckout } from './workflow-checkout.ts'

/** A free /feature subject is not an issue. Do not gh-view it. */
export function issueReference(reference: string): boolean {
  return /^(?:#\d+|\d+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#\d+)$/.test(reference.trim())
}

function sameDirectory(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right)
  } catch {
    return false
  }
}

export function linkedMove(cwd: string, path: string): ContinueFeatureResult | null {
  if (sameDirectory(cwd, path)) return null
  return { kind: 'session-cwd', path, instruction: `/move ${path}` }
}

export function moveFromEvidence(cwd: string, evidence: readonly { detail?: unknown }[]): ContinueFeatureResult | null {
  for (const item of evidence) {
    const detail = item.detail
    if (!isRecord(detail) || typeof detail.path !== 'string' || typeof detail.instruction !== 'string') continue
    if (detail.instruction !== `/move ${detail.path}`) continue
    return linkedMove(cwd, detail.path)
  }
  return null
}

export function mandateBranch(mandate: HistoryRecord | null): string | null {
  if (mandate === null || mandate.kind !== 'mandate') return null
  const mandatePayload = payload(mandate)
  return typeof mandatePayload.branch === 'string' && mandatePayload.branch.length > 0 ? mandatePayload.branch : null
}

export function actionRequiresFeatureCheckout(action: string): boolean {
  return (
    action === 'plan' ||
    action === 'implement' ||
    action === 'assess-spec' ||
    action === 'attribute-ci' ||
    action === 'publish' ||
    action === 'review' ||
    action === 'fix' ||
    action === 'land'
  )
}

export async function requireMandateCheckout(input: {
  cwd: string
  git: GitRunner
  scope: Scope
  mandate: HistoryRecord
}): Promise<ContinueFeatureResult | null> {
  const branch = mandateBranch(input.mandate)
  const mandatePayload = input.mandate.kind === 'mandate' ? payload(input.mandate) : null
  const base = mandatePayload?.base
  if (branch === null || typeof base !== 'string' || base.length === 0) {
    return { kind: 'blocked', reason: 'mandate-checkout-unreadable' }
  }
  const prepared = await prepareFeatureCheckout({
    git: input.git,
    sessionCwd: input.cwd,
    branch,
    base,
    repository: input.scope.repository,
    detached: false,
  })
  if (prepared.status === 'blocked') return { kind: 'blocked', reason: prepared.reason }
  if (prepared.status === 'move') {
    return linkedMove(input.cwd, prepared.path) ?? { kind: 'blocked', reason: 'session-not-intended-worktree' }
  }
  return null
}
