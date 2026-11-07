/** Public UW admission, framing, identity, graph and Spec contracts. */

export { assessUwAdmission } from './engine/uw-admission.ts'
export { projectNativeUwChildren } from './engine/uw-child-admission.ts'
export {
  causeDependencyAdjustmentInputSchema,
  uwCreateInputSchema,
  uwProposalInputSchema,
} from './engine/uw-command-schema.ts'
export { assessUwCompletion } from './engine/uw-completion.ts'
export type {
  CauseWaitResolution,
  DependencyBasis,
  DependencyResolution,
  NativeDeliveryPullRequest,
  NativeOnlyAbsenceWitness,
  ObservedCommit,
  SpecVersionVector,
  UwCompletion,
  UwCompletionAssessment,
  UwCompletionObservation,
  UwDeliveryFacts,
  UwObservationFacts,
  UwWaitProjection,
  WaitRequirement,
} from './engine/uw-completion-types.ts'
export { toDiagnostic, toDiagnostics, uwDiagnosticSchema, uwLocationSchema } from './engine/uw-diagnostics.ts'
export { validateFramingAuthorization } from './engine/uw-framing-authorization.ts'
export {
  FRAMING_ADMISSION_HOLD_CODES,
  type FramingAdmissionHoldCode,
  type FramingMembership,
  type FramingMissingFact,
} from './engine/uw-framing-hold.ts'
export { readFramingCoverageIntent, readFramingMembership } from './engine/uw-framing-membership.ts'
export {
  boundFramingCoverageIntentSchema,
  type FramingMemberAuthorization,
  type FramingProposal,
  type FramingReceiptPayload,
  type FramingReceiptRef,
  framingAllocationSchema,
  framingMaterialSchema,
  framingMemberAuthorizationSchema,
  framingProposalSchema,
  framingReceiptPayloadSchema,
  framingReceiptRefSchema,
  preparedFramingMemberSchema,
} from './engine/uw-framing-receipt-schema.ts'
export { type FramingRegistry, reconstructFramingRegistry } from './engine/uw-framing-registry.ts'
export {
  type FramingAccountedDecision,
  type FramingAggregateInput,
  type FramingCoverageIntent,
  type FramingDestinationMerge,
  type FramingEdge,
  type FramingMaterialCapture,
  type FramingMaterialId,
  type FramingMemberKey,
  type FramingMemberSlot,
  type FramingNonUwMember,
  type FramingSlotSelection,
  type FramingSourceBinding,
  type FramingSourceOrigin,
  type FramingUwMember,
  framingAccountedDecisionSchema,
  framingAggregateInputSchema,
  framingCoverageIntentSchema,
  framingDestinationMergeSchema,
  framingEdgeSchema,
  framingMaterialCaptureSchema,
  framingMaterialIdSchema,
  framingMemberKeySchema,
  framingMemberSchema,
  framingMemberSlotSchema,
  framingObligationSchema,
  framingSlotSelectionSchema,
  framingSourceBindingSchema,
  framingSourceOriginSchema,
  framingSourceRefSchema,
} from './engine/uw-framing-schema.ts'
export { framingAcceptedStateDigest, framingObservationDigest } from './engine/uw-framing-state.ts'
export type { UwGraphObservation } from './engine/uw-graph.ts'
export {
  cycleKeys,
  isWayfinder,
  knownWayfinderLabels,
  relationGraph,
  sameScope,
  scopeKey,
  unknownWayfinderLabels,
  validateUwGraph,
  WAYFINDER_LABELS,
} from './engine/uw-graph.ts'
export { prepareNewSpecAllocation, prepareSpecAllocation, resolveSpecIdentityLedger } from './engine/uw-identity.ts'
export {
  buildFramingSpecIdentity,
  buildSpecIdentityAllocation,
  buildSpecIdentityProposedRetirement,
} from './engine/uw-identity-events.ts'
export {
  operatorConfirmationEvidenceSchema,
  SPEC_IDENTITY_FORMAT,
  specIdentityPayloadSchema,
} from './engine/uw-identity-schema.ts'
export {
  type NativeIssueObservation,
  nativeIssueObservationSchema,
  nativeObservationDigest,
} from './engine/uw-native-observation-schema.ts'
export { normalizationJudgementSchema } from './engine/uw-normalization-schema.ts'
export { canonicalSpec, specVersion, validateSpecIds } from './engine/uw-spec.ts'
export type { OwnSpecRef } from './engine/uw-spec-schema.ts'
export {
  criterionIdSchema,
  invariantIdSchema,
  SPEC_CONTENT_FORMAT,
  specContentSchema,
  specDraftSchema,
  specItemIdSchema,
  specRawSourceSchema,
  specSchema,
  specSnapshotSchema,
  uwTierSchema,
} from './engine/uw-spec-schema.ts'
export { projectUwWaits } from './engine/uw-waits.ts'
