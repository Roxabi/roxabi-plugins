import type { ComplexityFactors } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type {
  IssueWriteObservation,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { ParsedIssueSpec } from '../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { AcceptedOwnSpecResult, ProposedOwnSpecResult, UwAdmission } from '../engine/uw-admission.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { SpecAllocationPlan, SpecIdentityLedger } from '../engine/uw-identity.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { NormalizationDecision, NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type { SpecDraft, SpecRawSource, UwTier } from '../engine/uw-spec.ts'
import type { PreparedMaterialAcceptance } from '../engine/workflow-spec-assessment.ts'

export type TierOverride = { tier: UwTier; reason: string } | null

export type UwWritePrecondition = {
  observed: IssueWriteObservation
  nativeDigest: string
  ledgerHead: ExternalRecordRef | null
  acceptedPredecessor: ExternalRecordRef | null
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
}

export type PreparedUwProposal = { proposal: UwProposal; digest: string }

export type OperatorResult<T> =
  | { status: 'confirmed'; value: T }
  | { status: 'refused'; diagnostics: readonly UwDiagnostic[] }
export type PreparedOperatorProposal = PreparedUwProposal | PreparedMaterialAcceptance

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
  graph: UwGraphObservation
  /** Reuses the complete graph/history observation for sibling current-child facts. */
  observedReader?: UwReadPort
}

export type UwOperationResult =
  | { status: 'written' | 'created' | 'accepted'; value: UwRead }
  | { status: 'refused'; diagnostics: readonly UwDiagnostic[] }
  | { status: 'partial'; uw: Scope; diagnostics: readonly UwDiagnostic[] }
  /** A create request may have reached GitHub but yielded no trustworthy issue reference. */
  | { status: 'uncertain'; diagnostics: readonly { code: string; message: string }[] }

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
  prepare(input: UwProposalInput | UwCreateInput): Promise<Result<PreparedUwProposal, UwDiagnostic>>
  /** Runtime parser is injected from the installed bundled engine facade. */
  validateNormalization(request: NormalizationProposalRequest, value: unknown): UwResult<NormalizationJudgement>
  write(input: UwProposalInput): Promise<UwOperationResult>
  create(input: UwCreateInput): Promise<UwOperationResult>
  acceptMaterial(uw: Scope): Promise<UwOperationResult>
}
