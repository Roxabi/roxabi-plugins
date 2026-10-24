import { Flag, is } from '@oh-my-pi/pi-ai/error/flags'

export { decodeHistory, encodeRecord } from './adapters/github/history-codec.ts'
export { publishGitHubRecord } from './adapters/github/publish.ts'
export { githubScope, readGitHubHistory } from './adapters/github/transport.ts'
export { type Gh, GitHubHistoryReadError, type GitHubOptions } from './adapters/github/types.ts'
export { readIssueParentAssociation, readLinkedIssueAssociation } from './adapters/github-workflow/associations.ts'
export {
  publishConfirmedWorkflowRecord,
  readLandingFacts,
  readWorkflowBinding,
} from './adapters/github-workflow/binding.ts'
export { readComposedWorkflowHistory } from './adapters/github-workflow/history.ts'
export {
  readNativeIssueFacts,
  readNativePullRequestFacts,
  readScopeIssueBody,
  resolveNativeScope,
  resolveNativeTarget,
} from './adapters/github-workflow/native-facts.ts'
export type {
  ComposedWorkflowHistory,
  IssueParentAssociation,
  LandingFactsRead,
  LinkedIssueAssociation,
  NativeIssueFacts,
  NativePullRequestFacts,
  NativeTargetResolution,
  WorkflowPublication,
} from './adapters/github-workflow/types.ts'
export {
  classifyHistory,
  type HistoryClassification,
  type HistoryOperationClass,
} from './engine/history-classification.ts'
export { validateRecordGraph } from './engine/history-graph.ts'
export {
  type DecodedHistory,
  decodedHistorySchema,
  type History,
  historySchema,
  type OperationAuthority,
  type OperationRead,
  operationAuthoritySchema,
  operationReadSchema,
} from './engine/history-schema.ts'
export { inspectFinding, PRODUCER_OUTPUTS, type ProducerOutput, producerJsonSchema } from './engine/producer-schema.ts'
export { buildRecord, parseRecord, type RecordDraft } from './engine/record-construction.ts'
export { equalScope } from './engine/record-diagnostics.ts'
export {
  type FailedCheckFailure,
  failedCheckEvidenceDigest,
  failedCheckFailureSchema,
  specDigest,
} from './engine/record-digests.ts'
export { projectRecord } from './engine/record-projection.ts'
export {
  type ExternalRecordRef,
  externalRecordRefSchema,
  isWorkflowKind,
  KIND_NAMES,
  kindSchema,
  type ProofConfigPin,
  proofConfigPinSchema,
  type ScopedRecordRef,
  scopedRecordRefSchema,
  stopBotMayAuthor,
  WORKFLOW_RECORD_KINDS,
  type WorkflowRecordKind,
} from './engine/record-references.ts'
export { type CanonicalRecord, type Kind, type Payloads, recordSchema } from './engine/record-schema.ts'
export {
  type ActionResult,
  actionResultSchema,
  applyActionResultSchema,
  type Contribution,
  commandResultSchema,
  contributionSchema,
  type Diagnostic,
  diagnosticSchema,
  type FindingData,
  type FindingReport,
  falsifyActionResultSchema,
  findingReportSchema,
  findingSchema,
  type Group,
  groupSchema,
  type ImplementationCommand,
  implementationCommandSchema,
  type Json,
  jsonSchema,
  type Label,
  type Location,
  labelSchema,
  locationSchema,
  type NativeOutcome,
  type NativeProofBashCallRecord,
  nativeOutcomeSchema,
  nativeProofBashCallSchema,
  type OriginalFinding,
  originalFindingSchema,
  type Phase,
  type Policy,
  phaseSchema,
  policySchema,
  type RecallClass,
  type RecallPlan,
  recallClassSchema,
  recallPlanSchema,
  type Scope,
  type Slot,
  type SpecReport,
  type SpecRow,
  type Submission,
  scopeSchema,
  slotSchema,
  specReportSchema,
  specRowSchema,
  submissionSchema,
  type Verdict,
  verdictSchema,
} from './engine/record-values.ts'
export type {
  DecisionAssessment,
  FindingInspection,
  RecordProjectionConfig,
  Result,
  ReviewFacts,
  ReviewState,
  ReviewSummary,
} from './engine/result.ts'
export { deriveRecallPlan } from './engine/review-conservation.ts'
export {
  type DecisionBindings,
  type ReviewDecisionBindings,
  validateDecision,
  validateDecisionBindings,
  validateRetainedUnusableLabels,
  validateReviewDecisionBindings,
} from './engine/review-decision.ts'
export {
  type Cause,
  type CorrectionResult,
  causeSchema,
  correctionResultSchema,
  type DebtReceipt,
  type Decision,
  debtReceiptSchema,
  decisionPayloadSchema,
  decisionSchema,
  type FalsificationResult,
  type FinalFinding,
  type FinalReview,
  type FixRequest,
  type FixResult,
  falsificationResultSchema,
  finalFindingSchema,
  finalReviewSchema,
  fixRequestSchema,
  fixResultSchema,
  type Inventory,
  inventorySchema,
  type ObservedComment,
  observedCommentSchema,
  type ReviewInputSnapshot,
  type ReviewStandards,
  type ReviewSubject,
  reviewInputSnapshotSchema,
  reviewStandardsSchema,
  reviewSubjectSchema,
  type Stop,
  standardsRowSchema,
  stopSchema,
} from './engine/review-schema.ts'
export { deriveReviewState, summarizeReviews } from './engine/review-state.ts'
export { resolveAcceptedSpec } from './engine/workflow-accepted-spec.ts'
export type {
  AcceptedSpec,
  AcceptedSpecRef,
  AcceptedSpecResult,
} from './engine/workflow-accepted-spec-types.ts'
export { actionCompletion } from './engine/workflow-action-completion.ts'
export type { BoundWork, ConfigIdentity, MandateUse } from './engine/workflow-binding.ts'
export { resolveBoundWork } from './engine/workflow-bound-work-resolution.ts'
export { composeChantier } from './engine/workflow-chantier.ts'
export { bindExternalRef, type MandateRecord, type PauseBinding } from './engine/workflow-control.ts'
export { assessFixMandate } from './engine/workflow-correction-admission.ts'
export { buildFixOnlyMandate, type FixMandateAssessment } from './engine/workflow-correction-mandate.ts'
export {
  validateWorkflowGraph,
  type WorkflowCondition,
  type WorkflowGraph,
  type WorkflowGraphAction,
  workflowConditionSchema,
  workflowGraphActionSchema,
  workflowGraphSchema,
} from './engine/workflow-graph.ts'
export type { LandingMandateDecision, LandingRefusal } from './engine/workflow-landing.ts'
export { requireLandingMandate } from './engine/workflow-landing-admission.ts'
export type { MandateRefusal, MandateSelection } from './engine/workflow-mandate.ts'
export { selectApplicableMandate } from './engine/workflow-mandate-admission.ts'
export {
  type MandatePayload,
  mandatePayloadSchema,
  type OperatorControlPayload,
  operatorControlPayloadSchema,
  type WorkflowBindingPayload,
  workflowBindingPayloadSchema,
} from './engine/workflow-mandate-schema.ts'
export {
  type CiAttribution,
  ciAttributionSchema,
  type ImplementationOutput,
  implementationOutputSchema,
  type PlanBlockerRef,
  type PlanOutput,
  type PlanResolution,
  type PlanReview,
  type PlanStep,
  planBlockerRefSchema,
  planDigest,
  planOutputSchema,
  planResolutionSchema,
  planReviewSchema,
  planStepSchema,
  type SpecAssessment,
  specAssessmentSchema,
} from './engine/workflow-output-schema.ts'
export {
  type ActionCompletion,
  bindImplementationCommand,
  type PlanMacro,
  type PlanMacroPhase,
  type WorkflowEvidence,
} from './engine/workflow-plan.ts'
export { planMacro } from './engine/workflow-plan-macro.ts'
export { selectWorkflowBinding, type WorkflowBindingSelection } from './engine/workflow-pr-binding.ts'
export {
  type ActionReceiptPayload,
  type AssessSpecResultPayload,
  actionReceiptPayloadSchema,
  type HostEffectAdmission,
  hostEffectAdmissionSchema,
  type ImplementationAdmissionCommand,
  implementationAdmissionCommandSchema,
  PLAN_REVIEW_SPECIALISTS,
  type PlanReviewSlot,
  planReviewSlotSchema,
  planReviewSpecialistSchema,
  type WorkflowReceiptAction,
  workflowReceiptActionSchema,
} from './engine/workflow-receipt-schema.ts'
export { reconstructWorkflow } from './engine/workflow-reconstruction-admission.ts'
export type {
  NativeSelector,
  NativeSelectorStatus,
  ProofSelector,
  SpecializedDecisions,
  WorkflowBlockReason,
  WorkflowDecision,
  WorkflowFacts,
} from './engine/workflow-reconstruction-types.ts'
export { partitionScopedRefs, scopedRefsOf } from './engine/workflow-record-references.ts'
export {
  type OmpBuildStartReviewParameters,
  ompBuildStartReviewParametersJsonSchema,
  ompBuildStartReviewParametersSchema,
} from './omp/tool-schemas.ts'
export { readEffectiveFixConfig } from './roxabi/workflow-config.ts'
export { shippedProductVersion } from './roxabi/workflow-config-digest.ts'

/** Session-boundary Esc/RPC user-abort: SDK stamps Flag.UserInterrupt on errorId. */
export function hasNativeUserInterruptFlag(errorId: number | undefined): boolean {
  return is(errorId, Flag.UserInterrupt)
}
