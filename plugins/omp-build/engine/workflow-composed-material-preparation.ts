import type { ComposedParentConsent } from './cause-disposition-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import type { UwNativeNode } from './uw-graph.ts'
import { type NativeIssueObservation, nativeIssueObservationSchema } from './uw-native-observation-schema.ts'
import { checkParentCreationDelta } from './workflow-composed-creation-delta.ts'
import { checkAssessmentDelta, issueFromScope } from './workflow-composed-observation.ts'
import { prepareParentConsent } from './workflow-composed-parent-consent.ts'
import type { CreatedChildBinding } from './workflow-mandate-schema.ts'
import type { MaterialAcceptanceInput } from './workflow-material-acceptance.ts'
import type { AssessResultRecord, PreparedMaterialAcceptance } from './workflow-spec-assessment.ts'

export function nativeIssueObservationFromNode(node: UwNativeNode): NativeIssueObservation | null {
  if (node.parent !== null && issueFromScope(node.parent) === null) return null
  const parsed = nativeIssueObservationSchema.safeParse({
    issue: issueFromScope(node.uw),
    title: node.title,
    body: node.raw.body,
    updatedAt: node.updatedAt,
    nativeState: node.native,
    labels: node.labels,
    parent: node.parent === null ? null : issueFromScope(node.parent),
    children: node.children.map(issueFromScope),
    blockers: node.blockers.map(issueFromScope),
  })
  return parsed.success ? parsed.data : null
}

/** Authenticate the exact native assessment pair and permit no other history or native movement. */
export function recheckComposedAssessmentDelta(input: {
  before: UwCompletionObservation
  after: UwCompletionObservation
  assessment: ExternalRecordRef
  mandate: ExternalRecordRef
}): Result<AssessResultRecord> {
  return checkAssessmentDelta(input, nativeIssueObservationFromNode)
}

/** Prepare the exact parent assessment/consent before public creation confirmation. */
export function prepareComposedParentConsent(input: {
  material: MaterialAcceptanceInput
  beforeAssessment: UwCompletionObservation
  observation: UwCompletionObservation
  createOperationId: string
  assessment: ExternalRecordRef
}): Result<{ prepared: PreparedMaterialAcceptance; consent: ComposedParentConsent }> {
  return prepareParentConsent(input, nativeIssueObservationFromNode)
}

/** Recheck the sealed before cut, allowing only this confirmed intent and the actual created child native delta. */
export function recheckComposedParentAcceptance(input: {
  prepared: PreparedMaterialAcceptance
  before: UwCompletionObservation
  after: UwCompletionObservation
  operation: ExternalRecordRef
  binding: CreatedChildBinding
}): Result<Extract<CanonicalRecord, { kind: 'operator-control' }>> {
  return checkParentCreationDelta(input, nativeIssueObservationFromNode)
}
