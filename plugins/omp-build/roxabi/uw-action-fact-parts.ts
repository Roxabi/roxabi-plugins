import { readUwCompletionObservation, toDiagnostics } from '../dist/contracts.js'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { equalScope } from '../engine/record-diagnostics.ts'
import { externalRecordRefSchema } from '../engine/record-references.ts'
import type { Result } from '../engine/result.ts'
import type { UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { ReceiptRecord } from '../engine/workflow-control.ts'
import { authenticateActionReplayStart } from '../engine/workflow-spec-authentication.ts'
import { plannerSuccessionInspection, plannerSuccessionStarts } from './feature-planner-succession.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { acceptedChain } from './uw-action-accepted-state.ts'
import { type ObserveCausalFacts, seedEvidenceObservation } from './uw-action-basis.ts'
import type {
  ActionInputManifest,
  ActionReplayIntent,
  ActionSubject,
  CorrectionRootRef,
  CurrentActionFacts,
  ReviewRootRef,
  UwActionRequest,
} from './uw-action-contract.ts'
import { bindAuthenticatedSubject, finishFacts } from './uw-action-fact-finish.ts'
import { type ActionFactSource, configuration, observeCode, readHistories } from './uw-action-observe.ts'
import { observeActionOperands } from './uw-action-operands.ts'
import { proposedSpec } from './uw-action-proposed-spec.ts'
import { actionFailure } from './uw-action-result.ts'
import { currentAccountedMandate } from './uw-action-selection.ts'
import { standaloneFacts } from './uw-action-standalone-facts.ts'
import { assessmentRecoveryReplay, assessmentSuccessionInspection } from './uw-assessment-prestart.ts'
import { createInstalledObservedUwReadPort } from './uw-read-port.ts'

export type { ActionFactSource }

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
  correctionRoot?: CorrectionRootRef,
  intent?: ActionReplayIntent,
): Promise<Result<CurrentActionFacts>> {
  if (request.subject.kind !== 'uw') return actionFailure('action-input-missing', 'UW subject is absent')
  const subject = request.subject
  const joint = await observeJointCompletion(subject, source, histories, observeCausal)
  if (!joint.ok) return joint
  const rawObservation = joint.value
  const persisted = persistedActionStart(request, subject, rawObservation.histories, intent, reviewedFingerprint)
  if (!persisted.ok) return persisted
  const persistedStart = persisted.value
  if (request.purpose === 'assess-spec' && intent === undefined)
    return actionFailure('action-input-missing', 'Assessment action facts require explicit replay intent')
  const assessment = await observeAssessmentReplay(
    request,
    subject,
    source,
    rawObservation,
    intent,
    reviewedFingerprint,
  )
  if (!assessment.ok) return assessment
  const { replay, inspection } = assessment.value
  const uwRead = await createInstalledObservedUwReadPort({
    observation: rawObservation,
    ...(replay === undefined ? {} : { assessmentReplay: replay }),
    ...(inspection === undefined ? {} : { assessmentInspection: inspection }),
  }).readUw(subject.uw)
  const observation = uwRead.observation
  if (observation.status !== 'complete') return { ok: false, diagnostics: toDiagnostics(observation.diagnostics) }
  const sameCutHistories = observation.histories
  const bound = bindAuthenticatedSubject(request, subject, sameCutHistories, observed, persistedStart)
  if (!bound.ok) return bound
  const currentInspection = inspection
  const accepted = acceptedChain(
    request,
    sameCutHistories,
    bound.value.mandate,
    config,
    uwRead.observation.graph,
    replay,
    currentInspection,
    uwRead.historical,
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
    correctionRoot,
    replay,
    intent,
    currentInspection,
    uwRead.historical,
  )
}

async function observeAssessmentReplay(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  source: ActionFactSource,
  rawObservation: Extract<UwCompletionObservation, { status: 'complete' }>,
  intent: ActionReplayIntent | undefined,
  reviewedFingerprint: string | undefined,
) {
  const home = rawObservation.histories.find((history) => equalScope(history.source.scope, subject.uw))
  const current = home === undefined ? null : currentAccountedMandate(home)
  const proof = current?.ok
    ? await plannerSuccessionInspection(current.value, {
        histories: rawObservation.histories,
        catalogues: rawObservation.catalogues,
        observation: rawObservation,
      })
    : { ok: true as const, value: undefined }
  if (!proof.ok) return proof
  const disposition =
    current?.ok && intent !== undefined
      ? await plannerSuccessionStarts(
          current.value,
          {
            histories: rawObservation.histories,
            catalogues: rawObservation.catalogues,
            observation: rawObservation,
          },
          source,
        )
      : { ok: true as const, value: new Set<string>() }
  if (!disposition.ok) return disposition
  const recovered =
    intent === undefined
      ? { ok: true as const, value: undefined }
      : assessmentRecoveryReplay(request, rawObservation.histories, intent, reviewedFingerprint, disposition.value)
  if (!recovered.ok) return recovered
  return {
    ok: true as const,
    value: { replay: recovered.value, inspection: assessmentSuccessionInspection(proof.value) },
  }
}

function persistedActionStart(
  request: UwActionRequest,
  subject: Extract<ActionSubject, { kind: 'uw' }>,
  histories: readonly DecodedHistory[],
  intent: ActionReplayIntent | undefined,
  reviewedFingerprint: string | undefined,
): Result<ReceiptRecord | null> {
  if (intent?.kind !== 'persisted') return { ok: true, value: null }
  if (request.purpose === 'review' || request.purpose === 'correction')
    return actionFailure('action-input-missing', 'Review and correction replay require their own root authority')
  const startRef = intent.start
  const home = request.purpose === 'attribute-ci' ? subject.pullRequest : subject.uw
  if (
    reviewedFingerprint === undefined ||
    !externalRecordRefSchema.safeParse(startRef).success ||
    startRef.kind !== 'action-receipt' ||
    home === null ||
    !equalScope(startRef.scope, home)
  )
    return actionFailure('action-input-missing', 'Persisted action replay lacks its scoped START reference')
  const matches = histories.filter((history) => equalScope(history.source.scope, startRef.scope))
  if (matches.length !== 1 || matches[0] === undefined)
    return actionFailure('action-input-missing', 'Persisted action replay history is unavailable or ambiguous')
  const start = authenticateActionReplayStart(
    matches[0],
    startRef,
    request.purpose,
    request.actionId,
    reviewedFingerprint,
  )
  return start === null
    ? actionFailure('action-input-missing', 'Persisted action START is not authenticated')
    : { ok: true, value: start }
}

export async function readProductionActionFacts(
  request: UwActionRequest,
  source: ActionFactSource,
  reviewedFingerprint?: string,
  reviewedRoot?: ReviewRootRef,
  correctionRoot?: CorrectionRootRef,
  intent?: ActionReplayIntent,
): Promise<Result<CurrentActionFacts>> {
  const observed = await observeCode(request, source).catch((error: unknown) =>
    actionFailure('action-code-moved', error instanceof Error ? error.message : 'code observation failed'),
  )
  if (!observed.ok) return observed
  const config = await configuration(source.cwd, request.code.referenceCommit, source.git)
  if (!config.ok) return config
  if (request.subject.kind === 'standalone-pr' && intent?.kind === 'persisted')
    return actionFailure('action-input-missing', 'Standalone review replay requires its own root authority')
  if (request.subject.kind === 'standalone-pr')
    return standaloneFacts(
      request,
      source,
      observed.value,
      config.value,
      reviewedFingerprint,
      undefined,
      reviewedRoot,
      undefined,
      correctionRoot,
    )
  return uwFacts(
    request,
    source,
    observed.value,
    config.value,
    reviewedFingerprint,
    undefined,
    undefined,
    reviewedRoot,
    correctionRoot,
    intent,
  )
}
