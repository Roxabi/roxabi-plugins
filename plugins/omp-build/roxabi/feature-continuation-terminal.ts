import { effectiveMandateRole } from '../dist/contracts.js'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowDecision } from '../engine/workflow-reconstruction-types.ts'
import { persistObservedCiStop } from '../skills/feature/workflow-review-state.js'
import type { SelectedFeature } from './feature-continuation-selection.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import { payload } from './feature-engine.ts'
import type { FeatureObservation } from './feature-observation-contract.ts'
import { moveFromEvidence } from './feature-selection.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'
import { acceptMaterialDecision } from './workflow-material-decision.ts'

type Continuation = (
  input: ContinueFeatureInput,
  exactMandateRef?: ScopedRecordRef,
  noImplicitResume?: boolean,
  completedReport?: boolean,
  landingReentry?: string,
) => Promise<ContinueFeatureResult>

export async function coordinateNonActionDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Exclude<WorkflowDecision, { status: 'action' }>,
  continueAt: Continuation,
): Promise<ContinueFeatureResult> {
  const stopped = await persistSelectedCiStop(selected, observation, decision)
  if (stopped !== null) return stopped
  if (decision.status === 'terminal' && decision.reason === 'done') {
    const admission = deliveryAdmission(observation, 'done')
    if (admission !== null) return admission
    const closed = await closeLinkedDelivery(input, selected, observation)
    if (closed !== null) return closed
    const reentered = await reenterCompletedParent(input, selected, observation, continueAt)
    if (reentered !== null) return reentered
  }
  return handleNonActionDecision(input, exactMandateRef, selected, observation, decision, continueAt)
}

async function persistSelectedCiStop(
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Exclude<WorkflowDecision, { status: 'action' }>,
): Promise<ContinueFeatureResult | null> {
  if (
    decision.status !== 'terminal' ||
    decision.reason !== 'bound-stop' ||
    observation.delivery === null ||
    observation.decisions.ciWatchStatus !== 'red' ||
    observation.decisions.reviewStep !== 'stop' ||
    observation.reviewId === null
  ) {
    return null
  }
  const { cwd, gh } = selected.authority.context
  try {
    if (
      !(await persistObservedCiStop(cwd, observation.delivery.number, {
        gh,
        expectedHead: observation.delivery.head,
        expectedReviewId: observation.reviewId,
      }))
    ) {
      return { kind: 'blocked', reason: 'ci-stop-observation-drift' }
    }
    return null
  } catch (error) {
    return {
      kind: 'blocked',
      reason: `ci-stop-unconfirmed:${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export async function reenterCompletedParent(
  input: ContinueFeatureInput,
  selected: SelectedFeature,
  observation: FeatureObservation,
  continueAt: Continuation,
): Promise<ContinueFeatureResult | null> {
  const mandate = selected.mandate
  const parent = mandate?.payload.parent
  if (
    mandate === null ||
    selected.acceptedSpec === null ||
    effectiveMandateRole(mandate.payload.role, selected.acceptedSpec) !== 'epic' ||
    parent?.kind !== 'mandate'
  )
    return null
  const scope = selected.authority.scope
  const read = await createInstalledObservedUwReadPort({
    observation: observation.evidence.causal.observation,
  }).readUw(scope)
  const completion = read.completion.completions.get(`${scope.repository}\0${scope.target}`)
  if (completion?.state !== 'complete') return { kind: 'blocked', reason: 'parent-completion-unavailable' }
  const { context } = selected.authority
  return continueAt(
    {
      ...input,
      cwd: context.cwd,
      reference: parent.scope.target,
      control: 'continue',
      principal: false,
      git: context.git,
      gh: context.gh,
    },
    parent,
    true,
  )
}

async function closeLinkedDelivery(
  input: ContinueFeatureInput,
  selected: SelectedFeature,
  observation: FeatureObservation,
): Promise<ContinueFeatureResult | null> {
  if (observation.delivery === null) return null
  if (selected.mandateRef === null) return { kind: 'blocked', reason: 'close-linked-mandate-unavailable' }
  if (input.uw === undefined) return { kind: 'blocked', reason: 'close-linked-unavailable' }
  const scope = selected.authority.scope
  const read = await createInstalledObservedUwReadPort({
    observation: observation.evidence.causal.observation,
  }).readUw(scope)
  const completion = read.completion.completions.get(`${scope.repository}\0${scope.target}`)
  if (completion?.state !== 'complete') return { kind: 'blocked', reason: 'close-linked-completion-unavailable' }
  if (selected.mandateRef.kind !== 'mandate') return { kind: 'blocked', reason: 'close-linked-mandate-unavailable' }
  const closed = await input.uw.closeLinked({
    uw: scope,
    mandate: { ...selected.mandateRef, kind: 'mandate' },
    pullRequest: observation.delivery.scope,
    completion,
  })
  if (closed.status !== 'written')
    return {
      kind: 'blocked',
      reason: `close-linked-${closed.status}`,
      ...('diagnostics' in closed ? { diagnostics: closed.diagnostics } : {}),
    }
  return null
}

export function deliveryAdmission(
  observation: FeatureObservation,
  action: Extract<WorkflowDecision, { status: 'action' }>['action'],
): ContinueFeatureResult | null {
  if (action === 'frame' || action === 'assess-spec' || action === 'resume') return null
  const admission = observation.deliveryAdmission
  if (admission === null) return { kind: 'blocked', reason: 'uw-delivery-admission-required' }
  const diagnostics = 'diagnostics' in admission ? admission.diagnostics : admission.admission.deliverable.diagnostics
  return diagnostics.length === 0 ? null : { kind: 'blocked', reason: 'uw-delivery-admission-refused', diagnostics }
}

async function handleNonActionDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  observation: FeatureObservation,
  decision: Exclude<WorkflowDecision, { status: 'action' }>,
  continueAt: Continuation,
): Promise<ContinueFeatureResult> {
  if (decision.status === 'blocked')
    return handleBlockedDecision(input, exactMandateRef, selected, decision, continueAt)
  if (decision.status === 'paused') return { kind: 'paused', confirmed: true, reason: 'paused' }
  if (decision.status === 'abandoned') return { kind: 'abandoned', confirmed: abandonmentConfirmed(observation) }
  return { kind: 'terminal', reason: decision.reason, diagnostics: decision.evidence }
}

async function handleBlockedDecision(
  input: ContinueFeatureInput,
  exactMandateRef: ScopedRecordRef | undefined,
  selected: SelectedFeature,
  decision: Extract<WorkflowDecision, { status: 'blocked' }>,
  continueAt: Continuation,
): Promise<ContinueFeatureResult> {
  const { context, scope } = selected.authority
  if (decision.reason === 'session-cwd')
    return moveFromEvidence(context.cwd, decision.evidence) ?? { kind: 'blocked', reason: 'session-cwd' }
  if (decision.reason !== 'spec-decision-required') {
    return { kind: 'blocked', reason: decision.reason, diagnostics: decision.evidence }
  }
  if (input.control !== 'material-decision') return { kind: 'operator-decision', reason: 'material-spec' }
  return acceptMaterialDecision(input, scope, () => continueAt({ ...input, control: 'resume' }, exactMandateRef))
}

function abandonmentConfirmed(observation: FeatureObservation): boolean {
  return observation.evidence.issue.operations.some((operation) => {
    const record = operation.record
    return (
      operation.status === 'complete' && record?.kind === 'operator-control' && payload(record).control === 'abandon'
    )
  })
}
