import type { RecordInputRef } from './action-input-refs.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { OwnSpecRef, SpecSnapshot } from './uw-spec.ts'
import type { UwTier } from './uw-spec-schema.ts'
import type { AcceptedChildCommitment, ParentCoverage } from './workflow-mandate-schema.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'

/** Frame-private structural operand, never public accepted authority. */
export type PrefixOperand = Readonly<{
  ref: OwnSpecRef
  snapshot: SpecSnapshot
  tier: UwTier
  children: readonly AcceptedChildCommitment[]
  inheritedOwnSpecRefs: readonly OwnSpecRef[]
  coverage: ParentCoverage | null
  chain: readonly AcceptedSpecStep[]
}>
export type CompatibilityOperandReader = {
  prefix(ref: OwnSpecRef): Result<PrefixOperand>
  acceptedMetadata(state: AssessSpecExact['accepted'], captured: readonly RecordInputRef[]): Result<PrefixOperand>
}

export type AcceptedSpecStep =
  | { kind: 'mandate'; source: ExternalRecordRef; version: string }
  | { kind: 'editorial'; source: ExternalRecordRef; from: string; to: string }
  | {
      kind: 'accept-material'
      source: ExternalRecordRef
      assessment: ExternalRecordRef
      from: string
      to: string
      proposalDigest: string
    }

export type AcceptedOwnSpec = {
  ref: OwnSpecRef
  snapshot: SpecSnapshot
  tier: UwTier
  children: AcceptedChildCommitment[]
  inheritedOwnSpecRefs: OwnSpecRef[]
  coverage: ParentCoverage | null
  chain: readonly AcceptedSpecStep[]
  sourceRefs: readonly ExternalRecordRef[]
}

export type AcceptedSpecResult =
  | { ok: true; spec: AcceptedOwnSpec }
  | { ok: false; reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'; evidence: Diagnostic[] }
