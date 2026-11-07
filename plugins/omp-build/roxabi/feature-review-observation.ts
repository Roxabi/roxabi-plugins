import { effectiveMandateRole } from '../dist/contracts.js'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { NativeSelector, SpecializedDecisions, WorkflowFacts } from '../engine/workflow-reconstruction-types.ts'
import { epicStep } from '../skills/feature/epic-driver.ts'
import type { WithdrawalBarrier } from '../skills/feature/workflow-gate.js'
import { readReviewRecords } from '../skills/feature/workflow-records.js'
import { nextReviewStep, reviewStep } from '../skills/feature/workflow-review-state.js'
import { classifyRedCiBeforeDispatch } from './feature-ci-correction.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { Delivery } from './feature-delivery-facts.ts'
import { isRecord } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'

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
  barriers: WithdrawalBarrier[],
): Promise<ReviewObservation | ContinueFeatureResult> {
  const head = delivery?.head ?? null
  const ciWatchStatus = delivery === null ? null : await currentCiWatchStatus(context.gh, context.cwd, delivery.number)
  const ci = await readRedCiEvidence(merged, delivery, head, ciWatchStatus, context)
  if (isContinuationResult(ci)) return ci
  const canonicalReview =
    delivery !== null && head !== null
      ? await currentReviewStep(context.cwd, delivery.number, head, context.gh, ciWatchStatus === 'red', barriers)
      : null
  const review = merged && canonicalReview?.action !== 'stop' ? null : (canonicalReview?.action ?? null)
  if (!merged && delivery !== null && ciWatchStatus === 'red') {
    const gated = await classifyRedCiBeforeDispatch(context.cwd, delivery.number, context.gh, context.git, (barrier) =>
      barriers.push(barrier),
    )
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
  barriers: WithdrawalBarrier[] = [],
): Promise<CurrentReviewStep> {
  if (ciFailed) {
    try {
      const step = await nextReviewStep(cwd, number, { ciFailed: true, gh })
      if (step.barrier) barriers.push(step.barrier)
      return { action: step.action, reviewId: null }
    } catch {
      return { action: 'stop', reviewId: null }
    }
  }
  const records = await readReviewRecords(cwd, number, { gh })
  if (!records.ok) throw new Error(records.diagnostics[0]?.message || 'review-records-unreadable')
  const step = reviewStep(records.value, { head }).action
  return { action: step === 'stop' || records.value.head === head ? step : null, reviewId: records.value.reviewId }
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

/** Gather review and epic decisions against the same projected feature facts. */
export async function readObservationDecisions(
  selected: SelectedFeature,
  observation: Pick<FeatureObservation, 'delivery' | 'facts'> & { merged: boolean },
  barriers: WithdrawalBarrier[],
): Promise<(SpecializedDecisions & { reviewId: string | null }) | ContinueFeatureResult> {
  const { authority, mandate, number, acceptedSpec } = selected
  const { context, target } = authority
  const { delivery, facts, merged } = observation
  const review = await readReviewObservation(delivery, merged, context, barriers)
  if (isContinuationResult(review)) return review
  facts.failedChecks = review.failedChecks
  facts.evidenceDigest = review.evidenceDigest
  const epic = await readEpicStep(target, mandate, acceptedSpec, facts.currentSpec, context.cwd, number)
  if (isContinuationResult(epic)) return epic
  return buildSpecializedDecisions({
    reviewStep: review.review,
    reviewId: review.reviewId,
    epicStep: epic,
    ciWatchStatus: merged ? null : review.ciWatchStatus,
    pullRequestOpen: delivery !== null,
  })
}

function canonicalChildren(
  children: readonly { scope: { repository: string; target: string }; specVersion: string; tier: string }[],
): string[] {
  return children
    .map((child) => `${child.scope.repository}\0${child.scope.target}\0${child.specVersion}\0${child.tier}`)
    .sort()
}

function currentSpecMatchesAccepted(
  currentSpec: WorkflowFacts['currentSpec'],
  acceptedSpec: AcceptedOwnSpec | null,
): boolean {
  return (
    currentSpec !== null &&
    acceptedSpec !== null &&
    currentSpec.snapshot.spec.version === acceptedSpec.ref.version &&
    currentSpec.children.every((child) => 'scope' in child) &&
    JSON.stringify(currentSpec.snapshot.spec) === JSON.stringify(acceptedSpec.snapshot.spec) &&
    currentSpec.tier === acceptedSpec.tier &&
    JSON.stringify(canonicalChildren(currentSpec.children.filter((child) => 'scope' in child))) ===
      JSON.stringify(canonicalChildren(acceptedSpec.children)) &&
    JSON.stringify(currentSpec.inheritedOwnSpecRefs) === JSON.stringify(acceptedSpec.inheritedOwnSpecRefs) &&
    JSON.stringify(currentSpec.coverage) === JSON.stringify(acceptedSpec.coverage)
  )
}

async function readEpicStep(
  target: SelectedFeature['authority']['target'],
  mandate: SelectedFeature['mandate'],
  acceptedSpec: AcceptedOwnSpec | null,
  currentSpec: WorkflowFacts['currentSpec'],
  cwd: string,
  number: number,
): Promise<SpecializedDecisions['epicStep'] | ContinueFeatureResult> {
  if (
    target.status !== 'issue' ||
    mandate?.kind !== 'mandate' ||
    acceptedSpec === null ||
    !currentSpecMatchesAccepted(currentSpec, acceptedSpec) ||
    effectiveMandateRole(mandate.payload.role, acceptedSpec) !== 'epic'
  )
    return null
  try {
    return (await epicStep(cwd, number)).name
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { kind: 'blocked', reason: 'epic-step-failed', diagnostics: [{ code: 'epic-step-failed', message }] }
  }
}
function buildSpecializedDecisions(input: {
  reviewStep: SpecializedDecisions['reviewStep']
  reviewId: string | null
  epicStep: SpecializedDecisions['epicStep']
  ciWatchStatus: SpecializedDecisions['ciWatchStatus']
  pullRequestOpen: boolean
}): SpecializedDecisions & { reviewId: string | null } {
  const absent = (status: NativeSelector['status'] = 'absent'): NativeSelector => ({ status, evidence: [] })
  return {
    reviewStep: input.reviewStep,
    reviewId: input.reviewId,
    epicStep: input.epicStep,
    epicLand: null,
    ciWatchStatus: input.ciWatchStatus,
    publish: absent(input.pullRequestOpen ? 'published' : 'absent'),
    landing: absent(),
    watch: absent(),
  }
}
