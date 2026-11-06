import { canonicalValueDigest, readUwCompletionObservation, toDiagnostics } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { acceptedChain, bindSubject } from './uw-action-accepted-state.ts'
import {
  type EvidenceObservation,
  type ObserveCausalFacts,
  resolveEvidenceBasis,
  seedEvidenceObservation,
} from './uw-action-basis.ts'
import { causeActionData } from './uw-action-cause-data.ts'
import type {
  ActionInputManifest,
  ActionSubject,
  CurrentActionFacts,
  RecordInputRef,
  ReviewRootRef,
  UwActionRequest,
} from './uw-action-contract.ts'
import { expansionOrigin } from './uw-action-expansion-origin.ts'
import { type ActionFactSource, authenticate, configuration, observeCode, readHistories } from './uw-action-observe.ts'
import { observeActionOperands } from './uw-action-operands.ts'
import { proposedSpec } from './uw-action-proposed-spec.ts'
import { actionFailure } from './uw-action-result.ts'
import { authenticateReviewRoot } from './uw-action-review-root.ts'
import { assertCurrentOutputClosure, currentRootOutputRefs, selectDeliveryData } from './uw-action-selection.ts'
import type { IntegrationStageObservation } from './uw-action-stage-closure.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'
import { validateExpandedWorkflowLive } from './uw-context-negative-live.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'

export type { ActionFactSource }

function integrationOperands(
  request: UwActionRequest,
  mandate: Result<MandateRecord>,
  planActionId: string | null,
  operands: CurrentActionFacts['operands'],
): Result<CurrentActionFacts['operands']> {
  if (request.purpose === 'integrate' && (!mandate.ok || planActionId === null))
    return actionFailure('action-input-missing', 'Integration requires the current mandate and eligible plan')
  const selected =
    request.purpose === 'integrate' && mandate.ok && planActionId !== null
      ? { action: 'integrate' as const, exactInputs: { mandateId: mandate.value.recordId, planActionId } }
      : operands
  if (
    request.purpose === 'integrate' &&
    (selected === undefined ||
      request.operands === undefined ||
      canonicalValueDigest(selected) !== canonicalValueDigest(request.operands))
  )
    return actionFailure(
      'review-input-changed',
      'Integration operands differ from the same-cut eligible mandate and plan',
    )
  return { ok: true, value: selected }
}

async function finishFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  histories: readonly DecodedHistory[],
  catalogues: ReviewClassCatalogues,
  subject: ActionSubject,
  spec: ActionInputManifest['spec'],
  acceptedSources: RecordInputRef[],
  mandate: Result<MandateRecord>,
  operands: CurrentActionFacts['operands'],
  config: ActionInputManifest['configuration'],
  completionObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  integration: IntegrationStageObservation | undefined,
  reviewedFingerprint?: string,
  observation?: EvidenceObservation,
  reviewedRoot?: ReviewRootRef,
): Promise<Result<CurrentActionFacts>> {
  const authenticated = authenticateReviewRoot(request, histories, reviewedFingerprint, reviewedRoot, subject)
  if (!authenticated.ok) return authenticated
  const expansion = expansionOrigin(request, histories, reviewedFingerprint)
  if (!expansion.ok) return expansion
  if (expansion.value?.workflow !== undefined) {
    const live = await validateExpandedWorkflowLive(source, request, expansion.value.workflow)
    if (!live.ok) return live
  }
  const delivery = mandate.ok
    ? selectDeliveryData(
        request,
        mandate.value,
        histories,
        catalogues,
        completionObservation,
        (record) => authenticate(record, histories),
        expansion.value?.planner,
        spec,
        reviewedFingerprint,
      )
    : { ok: true as const, value: { refs: [], plannedPaths: [], planActionId: null } }
  if (!delivery.ok) return delivery
  const selected = integrationOperands(request, mandate, delivery.value.planActionId, operands)
  if (!selected.ok) return selected
  const selectedOperands = selected.value
  const currentOutputs = currentRootOutputRefs(request, histories, reviewedRoot, expansion.value?.root)
  const causes = causeActionData(request, histories, currentOutputs, catalogues)
  if (!causes.ok) return causes
  const deliveryData = [...delivery.value.refs, ...causes.value]
  const basis = await resolveEvidenceBasis(deliveryData, source, observation)
  if (!basis.ok) return basis
  const closed = assertCurrentOutputClosure(
    request,
    histories,
    catalogues,
    [...acceptedSources, ...deliveryData],
    reviewedRoot,
    expansion.value?.root,
    integration,
  )
  if (!closed.ok) return closed
  return {
    ok: true,
    value: {
      spec,
      subject,
      acceptedSources,
      deliveryData,
      plannedPaths: delivery.value.plannedPaths,
      ...(selectedOperands === undefined ? {} : { operands: selectedOperands }),
      currentOutputs,
      configuration: config,
      ...(expansion.value?.previous === undefined ? {} : { expansionPrevious: expansion.value.previous }),
    },
  }
}

async function observeJointCompletion(
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  source: ActionFactSource,
  histories?: readonly DecodedHistory[],
  observeCausal?: ObserveCausalFacts,
): Promise<Result<Extract<UwCompletionObservation, { status: 'complete' }>>> {
  const pull = subject.pullRequest
  const read =
    histories === undefined
      ? await readHistories(pull === null ? [subject.uw] : [subject.uw, pull], source)
      : { ok: true as const, value: histories }
  if (!read.ok) return read
  const prior = observeCausal === undefined ? null : await observeCausal()
  if (prior !== null && !prior.ok) return prior
  const before = source.createdChildAssessment?.before
  const expectedHistories = [
    ...read.value,
    ...(before?.histories ?? []),
    ...(prior?.ok ? prior.value.causal.histories : []),
  ]
  const observation = await readUwCompletionObservation(
    subject.uw,
    withRoxabiGitHubPolicy(source),
    (current) => loadReviewClassCatalogues({ histories: current, cwd: source.cwd, gh: source.gh }),
    before?.graph.nodes.map((node) => node.uw) ?? [],
    expectedHistories,
  )
  if (observation.status !== 'complete') return { ok: false, diagnostics: toDiagnostics(observation.diagnostics) }
  return { ok: true, value: observation }
}

export async function uwFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  observed: { branch: string; baseName: string },
  config: ActionInputManifest['configuration'],
  reviewedFingerprint?: string,
  histories?: readonly DecodedHistory[],
  observeCausal?: ObserveCausalFacts,
  reviewedRoot?: ReviewRootRef,
): Promise<Result<CurrentActionFacts>> {
  if (request.subject.kind !== 'uw') return actionFailure('action-input-missing', 'UW subject is absent')
  const subject = request.subject
  const joint = await observeJointCompletion(subject, source, histories, observeCausal)
  if (!joint.ok) return joint
  const observation = joint.value
  const replay =
    request.purpose === 'assess-spec' && reviewedFingerprint !== undefined
      ? { uw: subject.uw, actionId: request.actionId, fingerprint: reviewedFingerprint }
      : undefined
  const uwRead = await createInstalledObservedUwReadPort({
    observation,
    ...(replay === undefined ? {} : { assessmentReplay: replay }),
  }).readUw(subject.uw)
  const sameCutHistories = observation.histories
  const bound = bindSubject(request, subject, sameCutHistories, observed)
  if (!bound.ok) return bound
  const accepted = acceptedChain(
    request,
    sameCutHistories,
    bound.value.mandate,
    config,
    uwRead.observation.graph,
    replay,
  )
  if (!accepted.ok) return accepted
  const spec = await proposedSpec(request, subject, source, accepted.value.spec)
  if (!spec.ok) return spec
  const operands = await observeActionOperands(
    request,
    source,
    sameCutHistories,
    accepted.value.acceptedSpec,
    replay,
    uwRead,
  )
  if (!operands.ok) return operands
  const sources = [...accepted.value.acceptedSources, ...operands.value.identitySources]
  const uniqueSources = [...new Map(sources.map((ref) => [JSON.stringify([ref.record, ref.selector]), ref])).values()]
  const completeHistories = observation.histories
  const completeCatalogues = observation.catalogues
  return finishFacts(
    request,
    source,
    completeHistories,
    completeCatalogues,
    bound.value.subject,
    spec.value,
    uniqueSources,
    bound.value.mandate,
    operands.value.operands,
    accepted.value.configuration,
    observation,
    request.purpose === 'integrate' && accepted.value.acceptedSpec !== null
      ? { read: uwRead, accepted: accepted.value.acceptedSpec, acceptedSources: uniqueSources }
      : undefined,
    reviewedFingerprint,
    seedEvidenceObservation(completeHistories),
    reviewedRoot,
  )
}

export async function readProductionActionFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  reviewedFingerprint?: string,
  reviewedRoot?: ReviewRootRef,
): Promise<Result<CurrentActionFacts>> {
  const observed = await observeCode(request, source).catch((error: unknown) =>
    actionFailure('action-code-moved', error instanceof Error ? error.message : 'code observation failed'),
  )
  if (!observed.ok) return observed
  const config = await configuration(source.cwd, request.code.referenceCommit, source.git)
  if (!config.ok) return config
  if (request.subject.kind === 'standalone-pr')
    return standaloneFacts(request, source, observed.value, config.value, reviewedFingerprint, undefined, reviewedRoot)
  return uwFacts(request, source, observed.value, config.value, reviewedFingerprint, undefined, undefined, reviewedRoot)
}
