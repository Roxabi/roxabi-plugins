import { canonicalValueDigest } from './canonical-value.ts'
import type { CauseCreationProposal, ComposedParentConsent } from './cause-disposition-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail, sameOwnSpecRef, sameRef } from './record-diagnostics.ts'
import { specDigest } from './record-digests.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { type UwCreatePlan, uwCreatePlanSchema } from './uw-create-plan-schema.ts'
import type { OperatorConfirmationEvidence } from './uw-identity-schema.ts'
import { bindExternalRef, historyFor, workflowOperationProblem } from './workflow-control.ts'
import type { CreatedChildBinding, MaterialAuthorization } from './workflow-mandate-schema.ts'
import {
  isAssessResult,
  type MaterialAcceptanceProposal,
  materialAcceptanceDigest,
} from './workflow-spec-assessment.ts'

type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Identity = Extract<CanonicalRecord, { kind: 'spec-identity' }>
export type ComposedIntentInput = {
  proposal: MaterialAcceptanceProposal
  authorization: Extract<MaterialAuthorization, { kind: 'cause-creation' }>
  confirmation: OperatorConfirmationEvidence
  histories: readonly DecodedHistory[]
}
export type ComposedIntent = {
  outer: CauseCreationProposal
  consent: ComposedParentConsent
  identity: Identity
  digest: string
  core: UwCreatePlan
}
const equal = (a: unknown, b: unknown) => canonicalValueDigest(a) === canonicalValueDigest(b)
const invalid = <T>(message: string): Result<T> => fail([diagnostic('material-composition-invalid', message)])
const issueScope = (issue: { repository: string; number: number }) => ({
  repository: issue.repository,
  target: `${issue.repository}#${issue.number}`,
})
const issueKey = (issue: { repository: string; number: number }) => `${issue.repository}\0${issue.number}`
const sorted = (items: readonly string[]) => [...items].sort()

function unresolvedChildClaims(history: DecodedHistory): boolean {
  return history.operations.some(
    (entry) =>
      (entry.kind === 'spec-identity' ||
        entry.claimedKinds.includes('spec-identity') ||
        entry.kind === 'mandate' ||
        entry.claimedKinds.includes('mandate')) &&
      (entry.authority === 'foreign' || entry.status !== 'complete' || entry.record === null),
  )
}

function creationRecords(input: ComposedIntentInput): Result<{ operation: Operation; identity: Identity }> {
  const { authorization, histories } = input
  const operationHistory = historyFor(authorization.operation.scope, histories)
  const childHistory = historyFor(authorization.binding.child, histories)
  if (operationHistory === null || childHistory === null)
    return invalid('Creation intent or child identity history is missing')
  if (
    workflowOperationProblem(operationHistory) !== null ||
    workflowOperationProblem(childHistory) !== null ||
    unresolvedChildClaims(childHistory)
  )
    return invalid('Creation or child authority history contains unresolved claims')
  const boundOperation = bindExternalRef(authorization.operation, operationHistory)
  const boundIdentity = bindExternalRef(authorization.binding.identity, childHistory)
  if (
    !boundOperation.ok ||
    boundOperation.value.kind !== 'cause-operation' ||
    !boundIdentity.ok ||
    boundIdentity.value.kind !== 'spec-identity'
  )
    return invalid('Creation intent and identity must be authenticated canonical records')
  return { ok: true, value: { operation: boundOperation.value, identity: boundIdentity.value } }
}

function creationContextProblem(
  outer: CauseCreationProposal,
  consent: ComposedParentConsent,
  input: ComposedIntentInput,
): string | null {
  const source = outer.creation.kind === 'sister' ? outer.creation.disposition : outer.creation.report
  const intendedParent =
    outer.creation.kind === 'sister' ? outer.creation.parent : (outer.creation.parentObservation?.parent ?? null)
  if (
    !equalScope(input.authorization.operation.scope, source.scope) ||
    intendedParent === null ||
    !equalScope(intendedParent, consent.parent)
  )
    return 'Creation intent does not belong to the source or the consented parent'
  const parentObservation = outer.creation.parentObservation
  if (
    parentObservation === null ||
    parentObservation.state !== 'active' ||
    !equalScope(parentObservation.parent, consent.parent) ||
    parentObservation.historyDigest !== consent.historyDigest ||
    parentObservation.nativeDigest !== consent.nativeObservationDigest
  )
    return 'Creation context does not bind the same active parent observation'
  const assessmentHistory = historyFor(input.proposal.assessment.scope, input.histories)
  const assessment = assessmentHistory === null ? null : bindExternalRef(input.proposal.assessment, assessmentHistory)
  if (assessment === null || !assessment.ok || !isAssessResult(assessment.value))
    return 'Composed assessment result is unavailable'
  const operands = assessment.value.payload.inputs.manifest.operands
  if (operands?.action !== 'assess-spec' || operands.origin.kind !== 'cause-created-child')
    return 'Composed assessment origin is not a created child'
  const { parentObservation: _originalParent, ...originalCreation } = operands.origin.creation
  const { parentObservation: _finalParent, ...finalCreation } = outer.creation
  return equal(originalCreation, finalCreation)
    ? null
    : 'Creation context differs from the context sealed in the assessment'
}

function confirmationBindsIntent(operation: Operation, intent: ComposedIntent, input: ComposedIntentInput): boolean {
  const { outer, consent, digest, core } = intent
  const { confirmation, proposal, authorization } = input
  const parsedCore = uwCreatePlanSchema.safeParse(core)
  return (
    parsedCore.success &&
    operation.recordId === `${outer.operationId}:intent` &&
    operation.operationId === `${outer.operationId}:intent` &&
    operation.payload.proposalDigest === digest &&
    equal(operation.payload.confirmation, confirmation) &&
    confirmation.operationId === outer.operationId &&
    confirmation.proposalDigest === digest &&
    consent.parentOperationId === proposal.operationId &&
    consent.parentProposalDigest === materialAcceptanceDigest(proposal) &&
    equalScope(consent.parent, proposal.uw) &&
    sameRef(consent.mandate, proposal.mandate) &&
    sameOwnSpecRef(consent.accepted, proposal.exactInputs.accepted.ref) &&
    sameRef(consent.predecessor, proposal.predecessor) &&
    sameRef(consent.assessment, proposal.assessment) &&
    equal(consent.exactInputs, proposal.exactInputs) &&
    equal(consent.versionVector, [consent.accepted, ...proposal.exactInputs.accepted.inheritedOwnSpecRefs]) &&
    consent.slot.operationId === outer.operationId &&
    equal(consent.slot, authorization.binding.slot)
  )
}

export function readComposedMaterialIntent(input: ComposedIntentInput): Result<ComposedIntent> {
  const records = creationRecords(input)
  if (!records.ok) return records
  const { operation, identity } = records.value
  const outer = operation.payload.proposal
  if (outer.operation !== 'create' || outer.parentAcceptance === null)
    return invalid('Creation intent has no composed parent consent')
  const consent = outer.parentAcceptance
  const contextProblem = creationContextProblem(outer, consent, input)
  if (contextProblem !== null) return invalid(contextProblem)
  const digest = specDigest(JSON.stringify(outer))
  const { creation: _creation, parentAcceptance: _parentAcceptance, ...core } = outer
  const intent = { outer, consent, identity, digest, core }
  if (!confirmationBindsIntent(operation, intent, input))
    return invalid('Creation confirmation or sealed parent consent does not bind the exact material proposal')
  return { ok: true, value: intent }
}

export function createdChildReadbackProblem(
  intent: ComposedIntent,
  binding: CreatedChildBinding,
  confirmation: OperatorConfirmationEvidence,
): string | null {
  const { outer, consent, identity, digest } = intent
  if (
    !equalScope(binding.identity.scope, binding.child) ||
    !equalScope(issueScope(binding.observed.issue), binding.child) ||
    binding.child.repository !== outer.target.repository ||
    binding.snapshot.raw.reference !== binding.child.target ||
    binding.snapshot.raw.body !== outer.renderedBody ||
    binding.snapshot.raw.body !== binding.observed.body ||
    binding.snapshot.raw.bodySha256 !== specDigest(binding.observed.body) ||
    !equal(binding.snapshot.spec, outer.allocation.spec) ||
    binding.observed.title !== outer.title ||
    binding.observed.nativeState.state !== 'OPEN' ||
    binding.observed.nativeState.stateReason !== null
  )
    return 'Created child identity, native issue, body or Spec differs from the sealed creation plan'
  if (
    identity.payload.event !== 'allocate' ||
    identity.payload.predecessor !== null ||
    identity.operationId !== outer.operationId ||
    identity.payload.proposalDigest !== digest ||
    !equal(identity.payload.confirmation, confirmation) ||
    !equal(identity.payload.allocations, outer.allocation.assignments)
  )
    return 'Created child allocation does not bind the confirmed creation plan'
  const relations = outer.writes.relations
  const expectedParent = relations.parent ?? null
  if (expectedParent === null || !equalScope(issueScope(expectedParent), consent.parent))
    return 'Created child native parent does not match the consented parent'
  const labels = outer.writes.labels.add.filter((label) => !outer.writes.labels.remove.includes(label))
  const children = relations.addChildren.filter(
    (item) => !relations.removeChildren.some((removed) => issueKey(removed) === issueKey(item)),
  )
  const blockers = relations.addBlockers.filter(
    (item) => !relations.removeBlockers.some((removed) => issueKey(removed) === issueKey(item)),
  )
  if (
    !equal(binding.observed.parent, expectedParent) ||
    !equal(sorted(binding.observed.labels), sorted(labels)) ||
    !equal(sorted(binding.observed.children.map(issueKey)), sorted(children.map(issueKey))) ||
    !equal(sorted(binding.observed.blockers.map(issueKey)), sorted(blockers.map(issueKey)))
  )
    return 'Created child readback differs from the sealed label or relation intents'
  return null
}
