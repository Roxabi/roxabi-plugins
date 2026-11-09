import type { FramingInvocationBinding } from '../engine/framing-context-schema.ts'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { FramingAdmissionHoldCode } from '../engine/uw-framing-hold.ts'
import type {
  BoundFramingCoverageIntent,
  FramingProposal,
  FramingReceiptPayload,
  FramingReceiptRef,
} from '../engine/uw-framing-receipt-schema.ts'
import type { FramingAggregateInput, FramingMemberKey } from '../engine/uw-framing-schema.ts'

export type PreparedFramingProposal = Readonly<{ proposal: FramingProposal; digest: string }>
export type FramingEffectGuard = {
  check(point: {
    operationId: string
    proposalDigest: string
    member: FramingMemberKey | null
    effectId: string
    at: 'confirmation' | 'before-effect' | 'after-readback'
  }): Promise<void>
}
export type FramingEffect = Readonly<{
  effectId: string
  member: FramingMemberKey | null
  kind:
    | 'create'
    | 'patch'
    | 'labels'
    | 'parent-child'
    | 'blocker'
    | 'publish-intent'
    | 'publish-binding'
    | 'publish-claim'
    | 'publish-identity'
    | 'publish-result'
  scope: Scope | null
  status: 'confirmed' | 'applied-readback-unconfirmed' | 'outcome-unknown' | 'failed-before-effect' | 'not-attempted'
  evidenceRefs: readonly ExternalRecordRef[]
  diagnostics: readonly UwDiagnostic[]
}>
export type FramingJournalHoldCode =
  | 'framing-create-uncertain'
  | 'framing-intent-unpublished'
  | 'framing-intent-uncertain'
  | 'framing-member-unbound'
  | 'framing-member-unclaimed'
  | 'framing-identity-unpublished'
  | 'framing-patch-unapplied'
  | 'framing-edge-unapplied'
  | 'framing-result-unpublished'
export type FramingHold = Readonly<{
  code: FramingJournalHoldCode
  member: FramingMemberKey | null
  scope: Scope | null
  effectId: string
  durable: FramingAdmissionHoldCode | null
}>
type ResultPayload = Extract<FramingReceiptPayload, { phase: 'result' }>
export type WrittenFramingGraph = Readonly<{
  kind: 'uw' | 'wayfinder'
  root: Scope
  intent: FramingReceiptRef
  result: FramingReceiptRef
  members: ResultPayload['members']
  coverageIntents: readonly BoundFramingCoverageIntent[]
  observationDigest: string
}>
export type FramingOperationResult =
  | { status: 'written'; value: WrittenFramingGraph; effects: readonly FramingEffect[] }
  | { status: 'refused'; effects: readonly []; diagnostics: readonly UwDiagnostic[] }
  | { status: 'deferred'; effects: readonly []; diagnostics: readonly UwDiagnostic[] }
  | {
      status: 'partial' | 'uncertain'
      root: Scope | null
      effects: readonly FramingEffect[]
      holds: readonly FramingHold[]
      diagnostics: readonly UwDiagnostic[]
    }
export type FramingOperations = {
  prepareFraming(
    input: FramingAggregateInput,
    invocation: FramingInvocationBinding,
  ): Promise<Result<PreparedFramingProposal, UwDiagnostic>>
  frame(prepared: PreparedFramingProposal, guard: FramingEffectGuard): Promise<FramingOperationResult>
}
