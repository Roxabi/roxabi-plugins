import type { CauseCreationContext } from './cause-creation-context-schema.ts'
import type { ComposedParentConsent } from './cause-disposition-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Result } from './result.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { isWayfinder, unknownWayfinderLabels } from './uw-graph.ts'
import { nativeObservationDigest } from './uw-native-observation-schema.ts'
import {
  checkAssessmentDelta,
  compositionStale,
  issueFromScope,
  type NativeObservationReader,
  sameObservationValue,
} from './workflow-composed-observation.ts'
import { readConsentAuthority } from './workflow-composed-parent-authority.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { type MaterialAcceptanceInput, prepareMaterialAcceptanceForAssessment } from './workflow-material-acceptance.ts'
import type { MaterialAcceptanceProposal, PreparedMaterialAcceptance } from './workflow-spec-assessment.ts'

export type ParentConsentInput = {
  material: MaterialAcceptanceInput
  beforeAssessment: UwCompletionObservation
  observation: UwCompletionObservation
  createOperationId: string
  assessment: ExternalRecordRef
}

function originalParentProblem(
  input: ParentConsentInput,
  origin: CauseCreationContext,
  native: NativeObservationReader,
): string | null {
  const originalParent = origin.parentObservation
  const beforeNode = input.beforeAssessment.graph.nodes.find((item) => equalScope(item.uw, input.material.uw))
  const beforeNative = beforeNode === undefined ? null : native(beforeNode)
  const beforeHistory = historyFor(input.material.uw, input.beforeAssessment.histories)
  if (
    originalParent === null ||
    originalParent.state !== 'active' ||
    !equalScope(originalParent.parent, input.material.uw) ||
    beforeNative === null ||
    beforeHistory === null ||
    originalParent.nativeDigest !== nativeObservationDigest(beforeNative) ||
    originalParent.historyDigest !== specDigest(JSON.stringify(beforeHistory))
  )
    return 'Assessment origin does not bind the original active parent observation'
  return null
}

function creationSourceProblem(origin: CauseCreationContext, histories: readonly DecodedHistory[]): string | null {
  const sourceRef = origin.kind === 'sister' ? origin.disposition : origin.report
  const sourceHistory = historyFor(sourceRef.scope, histories)
  const source = sourceHistory === null ? null : bindExternalRef(sourceRef, sourceHistory)
  if (
    source === null ||
    !source.ok ||
    specDigest(JSON.stringify(source.value)) !==
      (origin.kind === 'sister' ? origin.dispositionDigest : origin.reportDigest)
  )
    return 'Assessment creation source does not authenticate against its sealed origin'
  if (
    source.value.kind !== 'cause-disposition' ||
    (origin.kind === 'sister' && !equalScope(origin.original, sourceRef.scope))
  )
    return 'Assessment origin does not name the actual disposition source'
  if (origin.kind === 'sister') {
    const outcome = source.value.payload.outcome
    const relation =
      outcome.state === 'final' && outcome.disposition === 'sister-blocking'
        ? 'original-blocked-by-sister'
        : 'sister-blocked-by-original'
    if (origin.relation !== relation) return 'Assessment sister relation differs from its source disposition'
  }
  return null
}

function createdSlotProblem(
  proposal: MaterialAcceptanceProposal,
  origin: CauseCreationContext,
  input: ParentConsentInput,
): string | null {
  const slots = proposal.exactInputs.proposed.children.filter((child) => 'kind' in child)
  const slot = slots[0]
  if (slots.length !== 1 || slot === undefined || slot.operationId !== input.createOperationId)
    return 'Assessment does not contain exactly this creation slot'
  const parentIssue = issueFromScope(input.material.uw)
  if (
    parentIssue === null ||
    !sameObservationValue(slot.plan.writes.relations.parent, parentIssue) ||
    (origin.kind === 'sister' && (origin.parent === null || !equalScope(origin.parent, input.material.uw)))
  )
    return 'Assessment creation context and sealed core do not name the parent'
  return null
}

function attachedSourcesProblem(
  proposal: MaterialAcceptanceProposal,
  before: UwCompletionObservation,
  native: NativeObservationReader,
): string | null {
  for (const child of proposal.exactInputs.attachedChildren) {
    const actual = before.graph.nodes.find((node) => equalScope(node.uw, child.scope))
    if (
      !actual ||
      isWayfinder(actual) ||
      unknownWayfinderLabels(actual).length !== 0 ||
      actual.raw.reference !== child.snapshot.raw.reference ||
      actual.raw.body !== child.snapshot.raw.body ||
      actual.raw.bodySha256 !== child.snapshot.raw.bodySha256 ||
      !actual.labels.includes(`size:${child.tier}`) ||
      actual.labels.some((label) => label.startsWith('size:') && label !== `size:${child.tier}`)
    )
      return 'An attached child snapshot or tier differs from the original native observation'
  }
  for (const wayfinder of proposal.exactInputs.attachedWayfinders) {
    const scope = {
      repository: wayfinder.issue.repository,
      target: `${wayfinder.issue.repository}#${wayfinder.issue.number}`,
    }
    const node = before.graph.nodes.find((item) => equalScope(item.uw, scope))
    const actual = node === undefined ? null : native(node)
    if (
      node === undefined ||
      actual === null ||
      !isWayfinder(node) ||
      unknownWayfinderLabels(node).length !== 0 ||
      nativeObservationDigest(actual) !== nativeObservationDigest(wayfinder)
    )
      return 'An attached wayfinder differs from the original native observation'
  }
  return null
}

function prepareSealedConsent(
  input: ParentConsentInput,
  origin: CauseCreationContext,
  native: NativeObservationReader,
): Result<{ prepared: PreparedMaterialAcceptance; consent: ComposedParentConsent }> {
  const originalProblem = originalParentProblem(input, origin, native)
  if (originalProblem !== null) return compositionStale(originalProblem)
  const sourceProblem = creationSourceProblem(origin, input.observation.histories)
  if (sourceProblem !== null) return compositionStale(sourceProblem)
  const prepared = prepareMaterialAcceptanceForAssessment(input.material, input.assessment)
  if (!prepared.ok) return prepared
  const proposal = prepared.value.proposal
  const slotProblem = createdSlotProblem(proposal, origin, input)
  if (slotProblem !== null) return compositionStale(slotProblem)
  const attachedProblem = attachedSourcesProblem(proposal, input.beforeAssessment, native)
  if (attachedProblem !== null) return compositionStale(attachedProblem)
  const authority = readConsentAuthority(input.material, input.observation, proposal)
  if (!authority.ok) return authority
  const { accepted, effective, history } = authority.value
  const node = input.observation.graph.nodes.find((item) => equalScope(item.uw, input.material.uw))
  const currentNative = node === undefined ? null : native(node)
  if (currentNative === null) return compositionStale('Complete current parent native facts are required')
  return {
    ok: true,
    value: {
      prepared: prepared.value,
      consent: {
        parent: input.material.uw,
        mandate: { ...proposal.mandate, kind: 'mandate' },
        accepted: accepted.ref,
        predecessor: proposal.predecessor,
        versionVector: [...effective.versionVector],
        nativeObservationDigest: nativeObservationDigest(currentNative),
        historyDigest: specDigest(JSON.stringify(history)),
        assessment: { ...proposal.assessment, kind: 'action-receipt' },
        exactInputs: proposal.exactInputs,
        slot: { kind: 'created-by', operationId: input.createOperationId },
        parentOperationId: proposal.operationId,
        parentProposalDigest: prepared.value.digest,
      },
    },
  }
}

export function prepareParentConsent(
  input: ParentConsentInput,
  native: NativeObservationReader,
): Result<{ prepared: PreparedMaterialAcceptance; consent: ComposedParentConsent }> {
  const { material, beforeAssessment, observation, assessment } = input
  if (
    beforeAssessment.status !== 'complete' ||
    observation.status !== 'complete' ||
    !sameObservationValue(material.histories, observation.histories)
  )
    return compositionStale('Complete pre-assessment and post-assessment observation cuts are required')
  const mandateRef: ExternalRecordRef = { scope: material.uw, recordId: material.mandate.recordId, kind: 'mandate' }
  const delta = checkAssessmentDelta(
    { before: beforeAssessment, after: observation, assessment, mandate: mandateRef },
    native,
  )
  if (!delta.ok) return delta
  const operands = delta.value.payload.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'cause-created-child')
    return compositionStale('Assessment does not seal a cause-created-child origin')
  return prepareSealedConsent(input, operands.origin.creation, native)
}
