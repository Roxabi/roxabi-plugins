import type { ComplexityFactors } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type {
  IssueWriteObservation,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { ParsedIssueSpec } from '../adapters/github-native/uw-spec.ts'
import type { PreparedCauseDependencyAdjustment } from '../engine/cause-dependency-adjustment-schema.ts'
import type { ReportListing } from '../engine/cause-disposition.ts'
import type {
  CauseAdjudicationInput,
  CauseAdjudicationProposal,
  CauseSisterInput,
  CreationContext,
  ReportPromotionInput,
} from '../engine/cause-disposition-schema.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { ReviewClassCatalogues } from '../engine/review-class-catalogue.ts'
import type { SpecEffective } from '../engine/spec-effective-schema.ts'
import type { AcceptedOwnSpecResult, ProposedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { CauseDependencyAdjustmentInputJson } from '../engine/uw-command-schema.ts'
import type { UwCompletionAssessment, UwCompletionObservation } from '../engine/uw-completion-types.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { SpecAllocationPlan, SpecIdentityLedger } from '../engine/uw-identity.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { NormalizationDecision, NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { SpecDraft, SpecRawSource, UwTier } from '../engine/uw-spec.ts'
import type { OwnSpecRef } from '../engine/uw-spec-schema.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'
import type {
  ActionInputs,
  ActionSnapshot,
  PreparedUwAction,
  ReviewActionBatch,
  ReviewActionProjection,
  SelectedReview,
  UwActionRequest,
} from './uw-action-contract.ts'
import type { CauseAdjustmentResult } from './uw-cause-adjustment.ts'
import type { UwDeliveryRead } from './uw-delivery-read.ts'

export type TierOverride = { tier: UwTier; reason: string } | null

export type UwWritePrecondition = {
  observed: IssueWriteObservation
  nativeDigest: string
  ledgerHead: ExternalRecordRef | null
  acceptedPredecessor: ExternalRecordRef | null
  successorHistoryDigest?: string
}

export type UwProposalInput = {
  uw: Scope
  sourceBodySha256: SpecRawSource['bodySha256']
  draft: SpecDraft
  title: string
  factors: ComplexityFactors
  writes: Pick<NativeIssueWritePlan, 'labels' | 'relations'>
  normalization: readonly NormalizationDecision[]
  tierOverride: TierOverride
}

export type UwCreateInput = Omit<UwProposalInput, 'uw' | 'sourceBodySha256'> & { repository: string }

export type UwProposal = {
  format: 'omp-build-uw-proposal/1'
  operationId: string
  operation: 'normalize' | 'write' | 'create' | 'accept-material'
  target: { kind: 'existing'; uw: Scope } | { kind: 'create'; repository: string }
  expected: UwWritePrecondition | null
  draft: SpecDraft
  allocation: SpecAllocationPlan
  renderedBody: string
  title: string
  factors: ComplexityFactors
  tier: UwTier
  tierOverride: TierOverride
  writes: Pick<NativeIssueWritePlan, 'labels' | 'relations'>
  normalization: readonly NormalizationDecision[]
  assessment: ExternalRecordRef | null
  creation: CreationContext | null
}

export type PreparedUwProposal = { proposal: UwProposal; digest: string }
export type PreparedUwReopen = {
  proposal: {
    format: 'omp-build-uw-reopen/1'
    operationId: string
    uw: Scope
    accepted: OwnSpecRef
    before: IssueWriteObservation
    nativeDigest: string
    historyDigest: string
    effect: { state: 'OPEN'; stateReason: 'REOPENED' }
  }
  digest: string
}
export type PreparedUwAbandon = {
  proposal: {
    format: 'omp-build-uw-abandon/1'
    operationId: string
    uw: Scope
    mandate: ExternalRecordRef & { kind: 'mandate' }
    accepted: OwnSpecRef
    historyDigest: string
    nativeDigest: string
  }
  digest: string
}

export type OperatorResult<T> =
  | { status: 'confirmed'; value: T }
  | { status: 'refused'; diagnostics: readonly UwDiagnostic[] }
export type PreparedOperatorProposal =
  | PreparedUwProposal
  | PreparedMaterialAcceptance
  | PreparedCauseDependencyAdjustment
  | PreparedUwReopen
  | PreparedUwAbandon
  | { proposal: CauseAdjudicationProposal; digest: string }

/** Context-bound only: command argv and a native result cannot manufacture this capability. */
export type OperatorPort = {
  executeConfirmed<T>(
    proposal: PreparedOperatorProposal,
    action: (evidence: OperatorConfirmationEvidence) => Promise<T>,
  ): Promise<OperatorResult<T>>
}

export type UwRead = {
  uw: Scope
  parsed: ParsedIssueSpec
  identity: UwResult<SpecIdentityLedger>
  proposed: ProposedOwnSpecResult
  accepted: AcceptedOwnSpecResult
  admission: UwAdmission
  /** Canonically decoded histories used to compute this admission, retained for consumers. */
  histories: readonly DecodedHistory[]
  /** Immutable catalogue evidence loaded for these exact observed histories. */
  catalogues: ReviewClassCatalogues
  /** Whether this lexical observation completed typed closure and catalogue loading. */
  causalObservation:
    | { status: 'complete'; histories: readonly DecodedHistory[]; catalogues: ReviewClassCatalogues }
    | { status: 'unavailable' }
  graph: UwGraphObservation
  observation: UwCompletionObservation
  completion: UwCompletionAssessment
  /** Reuses the complete graph/history observation for sibling current-child facts. */
  observedReader?: UwReadPort
}

/** Creation readback is factual and carries no accepted or admission authority. */
export type CreatedUwRead = Pick<UwRead, 'uw' | 'parsed' | 'proposed' | 'identity' | 'histories' | 'graph'>
export type CreatedUwReadPort = { readUw(uw: Scope): Promise<CreatedUwRead> }

export type UwOperationResult =
  | { status: 'written' | 'accepted'; value: UwRead }
  | { status: 'created'; value: CreatedUwRead }
  | { status: 'abandoned'; uw: Scope }
  | { status: 'refused'; diagnostics: readonly UwDiagnostic[] }
  | { status: 'partial'; uw: Scope; diagnostics: readonly UwDiagnostic[] }
  /** A create request may have reached GitHub but yielded no trustworthy issue reference. */
  | { status: 'uncertain'; diagnostics: readonly { code: string; message: string }[] }

export type CauseOperationResult =
  | { status: 'adjudicated'; disposition: ExternalRecordRef & { kind: 'cause-disposition' } }
  | {
      status: 'created'
      value: CreatedUwRead
      receipt: ExternalRecordRef & { kind: 'debt-receipt' | 'report-promotion' }
    }
  | Extract<UwOperationResult, { status: 'refused' | 'partial' | 'uncertain' }>

/** Selection sends parser facts and native relation intent; the runner supplies judgement-only fields. */
export type NormalizationProposalRequest = {
  uw: Scope
  title: string
  parsed: ParsedIssueSpec
  graph: UwGraphObservation
  writes: Pick<NativeIssueWritePlan, 'labels' | 'relations'>
}

export type NormalizationProposalRunner = {
  propose(input: NormalizationProposalRequest): Promise<UwResult<NormalizationJudgement>>
}

/** Fresh native/parser/ledger/accepted projection shared by every UW consumer. */
export type UwReadPort = {
  readUw(uw: Scope): Promise<UwRead>
}

export interface UwOperations extends UwReadPort {
  readEffective(uw: Scope): Promise<UwResult<SpecEffective>>
  readCoverage(uw: Scope): Promise<UwResult<ParentCoverage | null>>
  readCompletion(uw: Scope): Promise<UwCompletionAssessment>
  /** Host-only completion effect on the one canonically bound UW after landing. */
  closeLinked(input: {
    uw: Scope
    mandate: ExternalRecordRef & { kind: 'mandate' }
    pullRequest: Scope
    completion: Extract<import('../engine/uw-completion-types.ts').UwCompletion, { state: 'complete' }>
  }): Promise<UwOperationResult>
  prepare(input: UwProposalInput | UwCreateInput): Promise<Result<PreparedUwProposal, UwDiagnostic>>
  listReports(uw: Scope): Promise<UwResult<ReportListing>>
  adjudicateCause(input: CauseAdjudicationInput): Promise<CauseOperationResult>
  createSister(input: CauseSisterInput): Promise<CauseOperationResult>
  adjustCauseDependency(input: CauseDependencyAdjustmentInputJson): Promise<CauseAdjustmentResult>
  promoteReport(input: ReportPromotionInput): Promise<CauseOperationResult>
  /** Runtime parser is injected from the installed bundled engine facade. */
  validateNormalization(request: NormalizationProposalRequest, value: unknown): UwResult<NormalizationJudgement>
  write(input: UwProposalInput): Promise<UwOperationResult>
  create(input: UwCreateInput): Promise<UwOperationResult>
  reopen(uw: Scope): Promise<UwOperationResult>
  abandon(uw: Scope, expectedMandate?: ExternalRecordRef & { kind: 'mandate' }): Promise<UwOperationResult>
  acceptMaterial(uw: Scope): Promise<UwOperationResult>
  prepareAction(
    input: UwActionRequest,
    projection?: ReviewActionProjection,
    review?: SelectedReview,
  ): Promise<Result<PreparedUwAction>>
  prepareReviewActions(input: ReviewActionBatch): Promise<Result<readonly PreparedUwAction[]>>
  replayActionInputs(input: {
    reviewed: ActionInputs
    request: UwActionRequest
    reviewedRoot?: SelectedReview['root']
  }): Promise<Result<ActionInputs>>
  verifyAction(snapshot: ActionSnapshot): Promise<Result<ActionSnapshot>>
  readDelivery(uw: Scope): Promise<UwResult<UwDeliveryRead>>
}
