import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import type { OwnSpecRef, SpecSnapshot } from './uw-spec.ts'
import type { UwTier } from './uw-spec-schema.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'

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
  chain: readonly AcceptedSpecStep[]
  sourceRefs: readonly ExternalRecordRef[]
}

export type AcceptedSpecResult =
  | { ok: true; spec: AcceptedOwnSpec }
  | { ok: false; reason: 'incomplete' | 'ambiguous' | 'material-spec' | 'missing-history'; evidence: Diagnostic[] }
