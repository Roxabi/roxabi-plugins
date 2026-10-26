import type { SpecializedDecisions } from '../engine/workflow-reconstruction-types.ts'
import { readReviewRecords } from '../skills/feature/workflow-records.js'
import { nextReviewStep, reviewStep } from '../skills/feature/workflow-review-state.js'
import { classifyRedCiBeforeDispatch } from './feature-ci-correction.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { Delivery } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'

export type ReviewObservation = {
  ciWatchStatus: SpecializedDecisions['ciWatchStatus']
  failedChecks: string[] | null
  evidenceDigest: string | null
  review: SpecializedDecisions['reviewStep']
  reviewId: string | null
}

export async function readReviewObservation(
  delivery: Delivery | null,
  merged: boolean,
  context: SelectedFeature['authority']['context'],
): Promise<ReviewObservation | ContinueFeatureResult> {
  const head = delivery?.head ?? null
  const ciWatchStatus = delivery === null ? null : await currentCiWatchStatus(context.gh, context.cwd, delivery.number)
  const ci = await readRedCiEvidence(merged, delivery, head, ciWatchStatus, context)
  if (isContinuationResult(ci)) return ci
  const canonicalReview =
    delivery !== null && head !== null
      ? await currentReviewStep(context.cwd, delivery.number, head, context.gh, ciWatchStatus === 'red')
      : null
  const review = merged && canonicalReview?.action !== 'stop' ? null : (canonicalReview?.action ?? null)
  if (!merged && delivery !== null && ciWatchStatus === 'red') {
    const gated = await classifyRedCiBeforeDispatch(context.cwd, delivery.number, context.gh, context.git)
    if (gated !== null) return gated
  }
  return {
    ciWatchStatus,
    failedChecks: ci.failedChecks,
    evidenceDigest: ci.evidenceDigest,
    review,
    reviewId: review === 'fix' ? (canonicalReview?.reviewId ?? null) : null,
  }
}

function isContinuationResult(value: unknown): value is ContinueFeatureResult {
  return value !== null && typeof value === 'object' && 'kind' in value
}

async function readRedCiEvidence(
  merged: boolean,
  delivery: Delivery | null,
  head: string | null,
  ciWatchStatus: SpecializedDecisions['ciWatchStatus'],
  context: SelectedFeature['authority']['context'],
): Promise<{ failedChecks: string[] | null; evidenceDigest: string | null } | ContinueFeatureResult> {
  if (merged || delivery === null || head === null || ciWatchStatus !== 'red') {
    return { failedChecks: null, evidenceDigest: null }
  }
  const live = await readNativeCiFailureEvidence(context.cwd, delivery.scope.repository, head, delivery.scope, {
    gh: context.gh,
    failedCheckEvidenceDigest: context.engine.failedCheckEvidenceDigest,
  })
  return live.ok
    ? { failedChecks: live.failedChecks, evidenceDigest: live.evidenceDigest }
    : { kind: 'blocked', reason: live.reason }
}

type CurrentReviewStep = {
  action: 'review' | 'fix' | 'land' | 'stop' | null
  reviewId: string | null
}

async function currentReviewStep(
  cwd: string,
  number: number,
  head: string,
  gh: SelectedFeature['authority']['context']['gh'],
  ciFailed = false,
): Promise<CurrentReviewStep> {
  if (ciFailed) {
    try {
      return { action: (await nextReviewStep(cwd, number, { ciFailed: true, gh })).action, reviewId: null }
    } catch {
      return { action: 'stop', reviewId: null }
    }
  }
  const records = await readReviewRecords(cwd, number, { gh })
  if (!records.ok) throw new Error(records.diagnostics[0]?.message || 'review-records-unreadable')
  const step = reviewStep(records.value, { head }).action
  return {
    action: step === 'stop' || step === 'review' || records.value.head === head ? step : null,
    reviewId: records.value.reviewId,
  }
}

async function currentCiWatchStatus(
  gh: SelectedFeature['authority']['context']['gh'],
  cwd: string,
  pr: number,
): Promise<SpecializedDecisions['ciWatchStatus']> {
  try {
    const parsed: unknown = JSON.parse(await gh(cwd, ['pr', 'view', String(pr), '--json', 'statusCheckRollup']))
    return isRecord(parsed) && Array.isArray(parsed.statusCheckRollup)
      ? summarizeCiChecks(parsed.statusCheckRollup)
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

function summarizeCiChecks(nodes: unknown[]): SpecializedDecisions['ciWatchStatus'] {
  const states = nodes.flatMap(ciCheckState)
  if (states.length === 0) return 'unknown'
  return states.includes('red') ? 'red' : states.includes('pending') ? 'pending' : 'green'
}

function ciCheckState(node: unknown): Array<'pending' | 'red' | 'green'> {
  if (!isRecord(node)) return []
  const status = typeof node.status === 'string' ? node.status.toLowerCase() : ''
  const conclusion = typeof node.conclusion === 'string' ? node.conclusion.toLowerCase() : ''
  const red = ['failure', 'timed_out', 'startup_failure'].includes(conclusion)
  return [status !== 'completed' ? 'pending' : red ? 'red' : 'green']
}
